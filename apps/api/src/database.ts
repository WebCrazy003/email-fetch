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
