import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';

@Injectable()
export class Database implements OnModuleInit, OnModuleDestroy {
  readonly pool = new Pool({
    connectionString: process.env.DATABASE_URL ?? 'postgres://email_fetch:email_fetch@localhost:5432/email_fetch',
    max: 15,
    idleTimeoutMillis: 30_000
  });

  query<T extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []) {
    return this.pool.query<T>(text, values);
  }

  async onModuleInit() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS saved_filters (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name text NOT NULL,
        source_id uuid NOT NULL REFERENCES sources(id),
        filters_json jsonb NOT NULL,
        legacy_search_history_id uuid UNIQUE,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      ALTER TABLE collection_jobs ADD COLUMN IF NOT EXISTS saved_filter_id uuid;
      DO $migration$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'collection_jobs_saved_filter_fk') THEN
          ALTER TABLE collection_jobs ADD CONSTRAINT collection_jobs_saved_filter_fk
            FOREIGN KEY (saved_filter_id) REFERENCES saved_filters(id) ON DELETE SET NULL;
        END IF;
      END
      $migration$;
      CREATE INDEX IF NOT EXISTS saved_filters_updated_idx ON saved_filters(updated_at DESC);
      CREATE INDEX IF NOT EXISTS collection_jobs_saved_filter_idx ON collection_jobs(saved_filter_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS email_templates (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, description text NOT NULL DEFAULT '',
        subject text NOT NULL, body_text text NOT NULL, revision integer NOT NULL DEFAULT 1,
        status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), archived_at timestamptz
      );
      CREATE TABLE IF NOT EXISTS email_provider_connections (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), provider_key text NOT NULL UNIQUE CHECK (provider_key IN ('gmail')),
        external_account_id text NOT NULL, account_address text NOT NULL, display_label text, credential_ciphertext text,
        granted_scopes text[] NOT NULL DEFAULT '{}'::text[],
        status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'unhealthy', 'revoked', 'disabled')),
        last_health_check_at timestamptz, last_error text, connected_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(), disconnected_at timestamptz
      );
      CREATE TABLE IF NOT EXISTS email_test_recipients (
        normalized_email text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS email_campaigns (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL,
        template_id uuid REFERENCES email_templates(id) ON DELETE SET NULL, template_revision integer NOT NULL,
        provider_connection_id uuid NOT NULL REFERENCES email_provider_connections(id), provider_adapter_version text NOT NULL DEFAULT '1.0.0',
        state text NOT NULL CHECK (state IN ('draft', 'validating', 'queued', 'sending', 'paused', 'provider_limited', 'cancelling', 'cancelled', 'completed', 'completed_with_errors', 'failed')),
        sender_name text NOT NULL, sender_address text NOT NULL, reply_to text, subject text NOT NULL, body_text text NOT NULL,
        purpose text NOT NULL, duplicate_policy text NOT NULL DEFAULT 'no_repeat_contact', selection_snapshot_json jsonb NOT NULL,
        counters_json jsonb NOT NULL DEFAULT '{}'::jsonb, started_at timestamptz, completed_at timestamptz,
        cancellation_requested_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
        failure_message text
      );
      CREATE TABLE IF NOT EXISTS campaign_recipients (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), campaign_id uuid NOT NULL REFERENCES email_campaigns(id) ON DELETE CASCADE,
        person_id uuid REFERENCES people(id) ON DELETE SET NULL, normalized_email text NOT NULL, recipient_address_snapshot text NOT NULL,
        merge_data_json jsonb NOT NULL DEFAULT '{}'::jsonb,
        state text NOT NULL CHECK (state IN ('selected', 'queued', 'sending', 'sent', 'retry_wait', 'failed', 'skipped_suppressed', 'skipped_invalid', 'skipped_already_sent', 'skipped_policy', 'cancelled')),
        terminal_result text CHECK (terminal_result IN ('sent', 'failed', 'skipped', 'cancelled')), skip_failure_reason text,
        attempt_count integer NOT NULL DEFAULT 0, next_retry_at timestamptz, idempotency_key text NOT NULL UNIQUE,
        provider_message_id text, provider_thread_id text, queued_at timestamptz, first_attempt_at timestamptz,
        sent_at timestamptz, failed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (campaign_id, normalized_email)
      );
      CREATE TABLE IF NOT EXISTS campaign_events (
        id bigserial PRIMARY KEY, campaign_id uuid NOT NULL REFERENCES email_campaigns(id) ON DELETE CASCADE,
        recipient_id uuid REFERENCES campaign_recipients(id) ON DELETE CASCADE,
        level text NOT NULL CHECK (level IN ('debug', 'info', 'warning', 'error')), event_type text NOT NULL,
        message text NOT NULL, metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS email_templates_active_name_idx ON email_templates(lower(name)) WHERE status = 'active';
      CREATE INDEX IF NOT EXISTS email_templates_status_updated_idx ON email_templates(status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS email_campaigns_state_created_idx ON email_campaigns(state, created_at DESC);
      CREATE INDEX IF NOT EXISTS campaign_recipients_claim_idx ON campaign_recipients(state, next_retry_at, created_at);
      CREATE INDEX IF NOT EXISTS campaign_recipients_campaign_idx ON campaign_recipients(campaign_id, created_at);
      CREATE INDEX IF NOT EXISTS campaign_events_campaign_created_idx ON campaign_events(campaign_id, created_at DESC);

      INSERT INTO saved_filters (name, source_id, filters_json, legacy_search_history_id, created_at, updated_at)
      SELECT COALESCE(NULLIF(h.label, ''), latest_job.name, 'GitHub filter'), s.id, h.filters_json, h.id,
        h.last_executed_at, h.last_executed_at
      FROM search_history h
      JOIN sources s ON s.source_key = 'github'
      LEFT JOIN LATERAL (
        SELECT j.name FROM search_executions e
        JOIN collection_jobs j ON j.id = e.collection_job_id
        WHERE e.search_history_id = h.id
        ORDER BY e.executed_at DESC LIMIT 1
      ) latest_job ON true
      WHERE h.context = 'new_collection'
      ON CONFLICT (legacy_search_history_id) DO NOTHING;

      UPDATE collection_jobs j SET saved_filter_id = f.id
      FROM search_executions e
      JOIN saved_filters f ON f.legacy_search_history_id = e.search_history_id
      WHERE e.collection_job_id = j.id AND j.saved_filter_id IS NULL;
    `);
  }

  async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}
