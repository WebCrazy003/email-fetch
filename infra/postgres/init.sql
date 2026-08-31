CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_key text NOT NULL UNIQUE,
  display_name text NOT NULL,
  adapter_version text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  capabilities_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS people (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  preferred_display_name text,
  lifecycle_status text NOT NULL DEFAULT 'active' CHECK (lifecycle_status IN ('active', 'suppressed', 'deleted')),
  is_suppressed boolean NOT NULL DEFAULT false,
  suppressed_at timestamptz,
  suppression_reason text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS source_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES sources(id),
  external_account_id text NOT NULL,
  normalized_username text NOT NULL,
  username text NOT NULL,
  display_name text,
  profile_url text NOT NULL,
  avatar_url text,
  bio text,
  company text,
  location text,
  account_type text NOT NULL DEFAULT 'user',
  blog_url text,
  twitter_username text,
  public_repos integer,
  public_gists integer,
  followers integer,
  following integer,
  hireable boolean,
  account_created_at timestamptz,
  source_updated_at timestamptz,
  last_public_activity_at timestamptz,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_checked_at timestamptz NOT NULL DEFAULT now(),
  is_suppressed boolean NOT NULL DEFAULT false,
  suppressed_at timestamptz,
  suppression_reason text,
  attributes_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (source_id, external_account_id),
  UNIQUE (source_id, normalized_username)
);

CREATE TABLE IF NOT EXISTS profile_field_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_account_id uuid NOT NULL REFERENCES source_accounts(id) ON DELETE CASCADE,
  field_name text NOT NULL,
  normalized_value_hash text NOT NULL,
  evidence_reference text NOT NULL,
  source_method text NOT NULL,
  collection_job_id uuid,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  last_verified_at timestamptz,
  UNIQUE (source_account_id, field_name, normalized_value_hash, source_method)
);

CREATE TABLE IF NOT EXISTS email_addresses (
  normalized_email text PRIMARY KEY,
  original_email text NOT NULL,
  is_publicly_declared boolean NOT NULL DEFAULT false,
  highest_confidence text NOT NULL CHECK (highest_confidence IN ('confirmed', 'likely', 'unsure')),
  best_discovery_type text NOT NULL CHECK (best_discovery_type IN ('source_profile', 'linked_website', 'guessed')),
  review_status text NOT NULL DEFAULT 'unreviewed' CHECK (review_status IN ('unreviewed', 'reviewed', 'rejected')),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  last_verified_at timestamptz,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'no_longer_public', 'invalid', 'suppressed', 'deleted')),
  validation_status text,
  successful_send_count integer NOT NULL DEFAULT 0,
  last_sent_at timestamptz,
  last_sent_campaign_id uuid,
  last_send_attempt_status text,
  last_send_attempt_at timestamptz
);

CREATE TABLE IF NOT EXISTS person_email_addresses (
  person_id uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  normalized_email text NOT NULL REFERENCES email_addresses(normalized_email) ON DELETE CASCADE,
  relationship_type text NOT NULL DEFAULT 'unknown' CHECK (relationship_type IN ('personal', 'work', 'shared', 'role_based', 'unknown')),
  link_confidence text NOT NULL DEFAULT 'unsure' CHECK (link_confidence IN ('confirmed', 'likely', 'unsure')),
  review_status text NOT NULL DEFAULT 'unreviewed' CHECK (review_status IN ('unreviewed', 'reviewed', 'rejected')),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (person_id, normalized_email)
);

CREATE TABLE IF NOT EXISTS collection_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text,
  source_id uuid NOT NULL REFERENCES sources(id),
  source_adapter_version text NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'paused', 'rate_limited', 'completed', 'completed_with_errors', 'failed', 'cancelling', 'cancelled')),
  phase text NOT NULL DEFAULT 'queued',
  filters_json jsonb NOT NULL,
  adapter_query_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  checkpoint_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  counters_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  failure_code text,
  failure_message text
);

DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'profile_field_sources_job_fk') THEN
    ALTER TABLE profile_field_sources
      ADD CONSTRAINT profile_field_sources_job_fk
      FOREIGN KEY (collection_job_id) REFERENCES collection_jobs(id) ON DELETE SET NULL;
  END IF;
END
$migration$;

CREATE TABLE IF NOT EXISTS email_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  normalized_email text NOT NULL REFERENCES email_addresses(normalized_email) ON DELETE CASCADE,
  source_account_id uuid NOT NULL REFERENCES source_accounts(id) ON DELETE CASCADE,
  collection_job_id uuid REFERENCES collection_jobs(id) ON DELETE SET NULL,
  source_method text NOT NULL,
  evidence_reference text NOT NULL,
  discovery_type text NOT NULL CHECK (discovery_type IN ('source_profile', 'linked_website', 'guessed')),
  confidence text NOT NULL CHECK (confidence IN ('confirmed', 'likely', 'unsure')),
  confidence_score numeric(5,4),
  derivation_rule text,
  evidence_excerpt text,
  evidence_status text NOT NULL DEFAULT 'active' CHECK (evidence_status IN ('active', 'no_longer_public', 'invalid', 'suppressed')),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  last_verified_at timestamptz,
  UNIQUE (normalized_email, source_account_id, source_method)
);

CREATE TABLE IF NOT EXISTS job_events (
  id bigserial PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES collection_jobs(id) ON DELETE CASCADE,
  level text NOT NULL CHECK (level IN ('debug', 'info', 'warning', 'error')),
  event_type text NOT NULL,
  message text NOT NULL,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS job_results (
  job_id uuid NOT NULL REFERENCES collection_jobs(id) ON DELETE CASCADE,
  source_account_id uuid NOT NULL REFERENCES source_accounts(id) ON DELETE CASCADE,
  person_id uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  outcome text NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  error_code text,
  PRIMARY KEY (job_id, source_account_id)
);

CREATE TABLE IF NOT EXISTS search_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  context text NOT NULL CHECK (context IN ('new_collection', 'collected_users', 'emails')),
  source_id uuid REFERENCES sources(id),
  filters_json jsonb NOT NULL,
  sort_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  label text,
  filter_hash text NOT NULL,
  last_executed_at timestamptz NOT NULL DEFAULT now(),
  execution_count integer NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  UNIQUE (context, filter_hash)
);

CREATE TABLE IF NOT EXISTS search_executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  search_history_id uuid NOT NULL REFERENCES search_history(id) ON DELETE CASCADE,
  collection_job_id uuid REFERENCES collection_jobs(id) ON DELETE SET NULL,
  result_count integer,
  executed_at timestamptz NOT NULL DEFAULT now()
);

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
    ALTER TABLE collection_jobs
      ADD CONSTRAINT collection_jobs_saved_filter_fk
      FOREIGN KEY (saved_filter_id) REFERENCES saved_filters(id) ON DELETE SET NULL;
  END IF;
END
$migration$;

CREATE TABLE IF NOT EXISTS suppressions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  suppression_type text NOT NULL CHECK (suppression_type IN ('email', 'domain', 'source_account_id', 'source_username')),
  source_id uuid REFERENCES sources(id),
  normalized_value text NOT NULL,
  reason text,
  suppression_source text NOT NULL DEFAULT 'manual',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id bigserial PRIMARY KEY,
  actor text NOT NULL DEFAULT 'local_operator',
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  request_correlation_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS email_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  subject text NOT NULL,
  body_text text NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);

CREATE TABLE IF NOT EXISTS email_provider_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_key text NOT NULL UNIQUE CHECK (provider_key IN ('gmail')),
  external_account_id text NOT NULL,
  account_address text NOT NULL,
  display_label text,
  credential_ciphertext text,
  granted_scopes text[] NOT NULL DEFAULT '{}'::text[],
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'unhealthy', 'revoked', 'disabled')),
  last_health_check_at timestamptz,
  last_error text,
  connected_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  disconnected_at timestamptz
);

CREATE TABLE IF NOT EXISTS email_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  template_id uuid REFERENCES email_templates(id) ON DELETE SET NULL,
  template_revision integer NOT NULL,
  provider_connection_id uuid NOT NULL REFERENCES email_provider_connections(id),
  provider_adapter_version text NOT NULL DEFAULT '1.0.0',
  state text NOT NULL CHECK (state IN ('draft', 'validating', 'queued', 'sending', 'paused', 'provider_limited', 'cancelling', 'cancelled', 'completed', 'completed_with_errors', 'failed')),
  sender_name text NOT NULL,
  sender_address text NOT NULL,
  reply_to text,
  subject text NOT NULL,
  body_text text NOT NULL,
  purpose text NOT NULL,
  duplicate_policy text NOT NULL DEFAULT 'no_repeat_contact',
  selection_snapshot_json jsonb NOT NULL,
  counters_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  cancellation_requested_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  failure_message text
);

CREATE TABLE IF NOT EXISTS campaign_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES email_campaigns(id) ON DELETE CASCADE,
  person_id uuid REFERENCES people(id) ON DELETE SET NULL,
  normalized_email text NOT NULL,
  recipient_address_snapshot text NOT NULL,
  merge_data_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  state text NOT NULL CHECK (state IN ('selected', 'queued', 'sending', 'sent', 'retry_wait', 'failed', 'skipped_suppressed', 'skipped_invalid', 'skipped_already_sent', 'skipped_policy', 'cancelled')),
  terminal_result text CHECK (terminal_result IN ('sent', 'failed', 'skipped', 'cancelled')),
  skip_failure_reason text,
  attempt_count integer NOT NULL DEFAULT 0,
  next_retry_at timestamptz,
  idempotency_key text NOT NULL UNIQUE,
  provider_message_id text,
  provider_thread_id text,
  queued_at timestamptz,
  first_attempt_at timestamptz,
  sent_at timestamptz,
  failed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, normalized_email)
);

CREATE TABLE IF NOT EXISTS campaign_events (
  id bigserial PRIMARY KEY,
  campaign_id uuid NOT NULL REFERENCES email_campaigns(id) ON DELETE CASCADE,
  recipient_id uuid REFERENCES campaign_recipients(id) ON DELETE CASCADE,
  level text NOT NULL CHECK (level IN ('debug', 'info', 'warning', 'error')),
  event_type text NOT NULL,
  message text NOT NULL,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS collection_jobs_status_created_idx ON collection_jobs(status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS email_templates_active_name_idx ON email_templates(lower(name)) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS email_templates_status_updated_idx ON email_templates(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS email_campaigns_state_created_idx ON email_campaigns(state, created_at DESC);
CREATE INDEX IF NOT EXISTS campaign_recipients_claim_idx ON campaign_recipients(state, next_retry_at, created_at);
CREATE INDEX IF NOT EXISTS campaign_recipients_campaign_idx ON campaign_recipients(campaign_id, created_at);
CREATE INDEX IF NOT EXISTS campaign_events_campaign_created_idx ON campaign_events(campaign_id, created_at DESC);
CREATE INDEX IF NOT EXISTS source_accounts_search_idx ON source_accounts(normalized_username, display_name, company, location);
CREATE INDEX IF NOT EXISTS source_accounts_username_trgm_idx ON source_accounts USING gin(normalized_username gin_trgm_ops);
CREATE INDEX IF NOT EXISTS source_accounts_name_trgm_idx ON source_accounts USING gin(display_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS source_accounts_company_trgm_idx ON source_accounts USING gin(company gin_trgm_ops);
CREATE INDEX IF NOT EXISTS source_accounts_location_trgm_idx ON source_accounts USING gin(location gin_trgm_ops);
CREATE INDEX IF NOT EXISTS source_accounts_first_seen_idx ON source_accounts(source_id, first_seen_at DESC);
CREATE INDEX IF NOT EXISTS source_accounts_checked_idx ON source_accounts(last_checked_at DESC);
CREATE INDEX IF NOT EXISTS email_addresses_management_idx ON email_addresses(status, highest_confidence, best_discovery_type, last_sent_at);
CREATE INDEX IF NOT EXISTS email_addresses_first_seen_idx ON email_addresses(first_seen_at DESC);
CREATE INDEX IF NOT EXISTS email_addresses_send_projection_idx ON email_addresses(successful_send_count, last_send_attempt_status, last_sent_at DESC);
CREATE INDEX IF NOT EXISTS person_email_email_idx ON person_email_addresses(normalized_email);
CREATE INDEX IF NOT EXISTS job_results_job_processed_idx ON job_results(job_id, processed_at DESC);
CREATE INDEX IF NOT EXISTS job_events_job_created_idx ON job_events(job_id, created_at DESC);
CREATE INDEX IF NOT EXISTS search_history_context_last_idx ON search_history(context, last_executed_at DESC);
CREATE INDEX IF NOT EXISTS search_executions_history_idx ON search_executions(search_history_id, executed_at DESC);
CREATE INDEX IF NOT EXISTS search_executions_job_idx ON search_executions(collection_job_id) WHERE collection_job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS saved_filters_updated_idx ON saved_filters(updated_at DESC);
CREATE INDEX IF NOT EXISTS collection_jobs_saved_filter_idx ON collection_jobs(saved_filter_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS suppressions_identity_idx
  ON suppressions(suppression_type, COALESCE(source_id, '00000000-0000-0000-0000-000000000000'::uuid), normalized_value);

INSERT INTO sources (source_key, display_name, adapter_version, capabilities_json)
VALUES (
  'github',
  'GitHub',
  '1.0.0',
  '{"accountType":"user","filters":["location","language","followers","repositories","created","activity","keywords","publicEmail","confidence"]}'::jsonb
)
ON CONFLICT (source_key) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  adapter_version = EXCLUDED.adapter_version,
  capabilities_json = EXCLUDED.capabilities_json,
  updated_at = now();
