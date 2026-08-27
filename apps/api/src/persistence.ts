import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { normalizeEmail, type Confidence, type DiscoveryType } from '@email-fetch/shared';
import { Database } from './database.js';
import type { GitHubProfile } from './github-adapter.js';

export interface EmailObservation {
  email: string;
  discoveryType: DiscoveryType;
  confidence: Confidence;
  score: number;
  sourceMethod: string;
  evidenceReference: string;
  evidenceExcerpt?: string;
  derivationRule?: string;
  publiclyDeclared: boolean;
}

export interface PersistResult {
  personId: string;
  sourceAccountId: string;
  isNewUser: boolean;
  newEmails: number;
  duplicateEmails: number;
  outcome: string;
}

const confidenceRank: Record<Confidence, number> = { unsure: 1, likely: 2, confirmed: 3 };
const discoveryRank: Record<DiscoveryType, number> = { guessed: 1, linked_website: 2, source_profile: 3 };

function profileFields(profile: GitHubProfile): Array<[string, unknown]> {
  const fields: Array<[string, unknown]> = [
    ['username', profile.login], ['display_name', profile.name], ['profile_url', profile.html_url],
    ['avatar_url', profile.avatar_url], ['bio', profile.bio], ['company', profile.company],
    ['location', profile.location], ['blog_url', profile.blog], ['twitter_username', profile.twitter_username],
    ['followers', profile.followers], ['following', profile.following], ['public_repos', profile.public_repos],
    ['public_gists', profile.public_gists], ['hireable', profile.hireable], ['account_type', profile.type],
    ['account_created_at', profile.created_at], ['source_updated_at', profile.updated_at]
  ];
  return fields.filter(([, value]) => value !== null && value !== undefined && value !== '');
}

export class PersistenceService {
  constructor(private readonly db: Database) {}

  async existingAccount(externalId: string) {
    const result = await this.db.query<{
      source_account_id: string; person_id: string; last_checked_at: Date; attributes_json: Record<string, unknown>;
    }>(
      `SELECT sa.id AS source_account_id, sa.person_id, sa.last_checked_at, sa.attributes_json
       FROM source_accounts sa JOIN sources s ON s.id = sa.source_id
       WHERE s.source_key = 'github' AND sa.external_account_id = $1`,
      [externalId]
    );
    return result.rows[0] ?? null;
  }

  async processedInJob(jobId: string, externalId: string) {
    const result = await this.db.query<{ exists: boolean }>(
      `SELECT EXISTS (
        SELECT 1 FROM job_results jr
        JOIN source_accounts sa ON sa.id = jr.source_account_id
        JOIN sources s ON s.id = sa.source_id
        WHERE jr.job_id = $1 AND s.source_key = 'github' AND sa.external_account_id = $2
      ) AS exists`,
      [jobId, externalId]
    );
    return result.rows[0]!.exists;
  }

  async isSuppressed(externalId: string, username: string) {
    const result = await this.db.query<{ exists: boolean }>(
      `SELECT EXISTS (
        SELECT 1 FROM suppressions su LEFT JOIN sources s ON s.id = su.source_id
        WHERE (su.suppression_type = 'source_account_id' AND su.normalized_value = $1)
           OR (su.suppression_type = 'source_username' AND s.source_key = 'github' AND su.normalized_value = $2)
      ) AS exists`,
      [externalId, username.toLowerCase()]
    );
    return result.rows[0]!.exists;
  }

  async recordSkipped(jobId: string, existing: { source_account_id: string; person_id: string }, outcome = 'skipped') {
    await this.db.query(
      `INSERT INTO job_results (job_id, source_account_id, person_id, outcome)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (job_id, source_account_id) DO UPDATE SET outcome = EXCLUDED.outcome, processed_at = now()`,
      [jobId, existing.source_account_id, existing.person_id, outcome]
    );
  }

  async persist(jobId: string, profile: GitHubProfile, activityAt: string | null, observations: EmailObservation[], websiteCheckedAt?: string): Promise<PersistResult> {
    return this.db.transaction(async (client) => {
      const source = await client.query<{ id: string }>(`SELECT id FROM sources WHERE source_key = 'github'`);
      const sourceId = source.rows[0]!.id;
      const existing = await client.query<{ id: string; person_id: string }>(
        `SELECT id, person_id FROM source_accounts WHERE source_id = $1 AND external_account_id = $2 FOR UPDATE`,
        [sourceId, String(profile.id)]
      );
      let personId: string;
      let sourceAccountId: string;
      const isNewUser = !existing.rows[0];
      if (existing.rows[0]) {
        personId = existing.rows[0].person_id;
        sourceAccountId = existing.rows[0].id;
        await client.query(`UPDATE people SET preferred_display_name = COALESCE($2, preferred_display_name), updated_at = now() WHERE id = $1`, [personId, profile.name ?? profile.login]);
        await client.query(
          `UPDATE source_accounts SET
            normalized_username = $2, username = $3, display_name = $4, profile_url = $5, avatar_url = $6,
            bio = $7, company = $8, location = $9, blog_url = $10, twitter_username = $11,
            public_repos = $12, public_gists = $13, followers = $14, following = $15, hireable = $16,
            account_created_at = $17, source_updated_at = $18, last_public_activity_at = $19,
            last_checked_at = now(), attributes_json = attributes_json || $20::jsonb
           WHERE id = $1`,
          [sourceAccountId, profile.login.toLowerCase(), profile.login, profile.name, profile.html_url, profile.avatar_url,
            profile.bio, profile.company, profile.location, profile.blog || null, profile.twitter_username,
            profile.public_repos, profile.public_gists, profile.followers, profile.following, profile.hireable,
            profile.created_at, profile.updated_at, activityAt, JSON.stringify(websiteCheckedAt ? { websiteCheckedAt } : {})]
        );
      } else {
        const person = await client.query<{ id: string }>(`INSERT INTO people (preferred_display_name) VALUES ($1) RETURNING id`, [profile.name ?? profile.login]);
        personId = person.rows[0]!.id;
        const account = await client.query<{ id: string }>(
          `INSERT INTO source_accounts (
            person_id, source_id, external_account_id, normalized_username, username, display_name, profile_url,
            avatar_url, bio, company, location, account_type, blog_url, twitter_username, public_repos,
            public_gists, followers, following, hireable, account_created_at, source_updated_at,
            last_public_activity_at, attributes_json
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'user',$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22::jsonb)
          RETURNING id`,
          [personId, sourceId, String(profile.id), profile.login.toLowerCase(), profile.login, profile.name, profile.html_url,
            profile.avatar_url, profile.bio, profile.company, profile.location, profile.blog || null, profile.twitter_username,
            profile.public_repos, profile.public_gists, profile.followers, profile.following, profile.hireable,
            profile.created_at, profile.updated_at, activityAt, JSON.stringify(websiteCheckedAt ? { websiteCheckedAt } : {})]
        );
        sourceAccountId = account.rows[0]!.id;
      }

      for (const [fieldName, value] of profileFields(profile)) {
        const hash = createHash('sha256').update(JSON.stringify(value)).digest('hex');
        await client.query(
          `INSERT INTO profile_field_sources
            (source_account_id, field_name, normalized_value_hash, evidence_reference, source_method, collection_job_id, last_verified_at)
           VALUES ($1, $2, $3, $4, 'github_api_profile', $5, now())
           ON CONFLICT (source_account_id, field_name, normalized_value_hash, source_method)
           DO UPDATE SET last_seen_at = now(), last_verified_at = now(), collection_job_id = EXCLUDED.collection_job_id`,
          [sourceAccountId, fieldName, hash, `https://api.github.com/users/${encodeURIComponent(profile.login)}`, jobId]
        );
      }

      let newEmails = 0;
      let duplicateEmails = 0;
      for (const observation of observations) {
        const normalized = normalizeEmail(observation.email);
        if (await this.emailSuppressed(client, normalized)) continue;
        const found = await client.query<{ highest_confidence: Confidence; best_discovery_type: DiscoveryType }>(
          `SELECT highest_confidence, best_discovery_type FROM email_addresses WHERE normalized_email = $1 FOR UPDATE`, [normalized]
        );
        if (found.rows[0]) duplicateEmails += 1;
        else newEmails += 1;
        if (found.rows[0]) {
          const otherOwners = await client.query<{ person_id: string }>(
            `SELECT person_id FROM person_email_addresses WHERE normalized_email = $1 AND person_id <> $2`,
            [normalized, personId]
          );
          if (otherOwners.rowCount) {
            await client.query(
              `INSERT INTO audit_log (action, target_type, target_id, metadata_json)
               VALUES ('email_identity_review_required', 'email', $1, $2::jsonb)`,
              [normalized, JSON.stringify({ observedForPersonId: personId, existingPersonIds: otherOwners.rows.map((row) => row.person_id) })]
            );
          }
        }
        const highest = found.rows[0] && confidenceRank[found.rows[0].highest_confidence]! > confidenceRank[observation.confidence]!
          ? found.rows[0].highest_confidence : observation.confidence;
        const bestType = found.rows[0] && discoveryRank[found.rows[0].best_discovery_type]! > discoveryRank[observation.discoveryType]!
          ? found.rows[0].best_discovery_type : observation.discoveryType;
        await client.query(
          `INSERT INTO email_addresses
            (normalized_email, original_email, is_publicly_declared, highest_confidence, best_discovery_type, last_verified_at)
           VALUES ($1,$2,$3,$4,$5,CASE WHEN $3 THEN now() ELSE NULL END)
           ON CONFLICT (normalized_email) DO UPDATE SET
             original_email = CASE WHEN EXCLUDED.is_publicly_declared THEN EXCLUDED.original_email ELSE email_addresses.original_email END,
             is_publicly_declared = email_addresses.is_publicly_declared OR EXCLUDED.is_publicly_declared,
             highest_confidence = $4, best_discovery_type = $5, last_seen_at = now(),
             last_verified_at = CASE WHEN EXCLUDED.is_publicly_declared THEN now() ELSE email_addresses.last_verified_at END,
             status = CASE WHEN email_addresses.status IN ('invalid','suppressed','deleted') THEN email_addresses.status ELSE 'active' END`,
          [normalized, observation.email, observation.publiclyDeclared, highest, bestType]
        );
        await client.query(
          `INSERT INTO person_email_addresses (person_id, normalized_email, relationship_type, link_confidence)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (person_id, normalized_email) DO UPDATE SET last_seen_at = now(),
             link_confidence = CASE
               WHEN person_email_addresses.link_confidence = 'confirmed' THEN 'confirmed'
               WHEN EXCLUDED.link_confidence = 'confirmed' THEN 'confirmed'
               WHEN person_email_addresses.link_confidence = 'likely' OR EXCLUDED.link_confidence = 'likely' THEN 'likely'
               ELSE 'unsure' END`,
          [personId, normalized, observation.discoveryType === 'guessed' ? 'unknown' : 'work', observation.confidence]
        );
        await client.query(
          `INSERT INTO email_sources (
            normalized_email, source_account_id, collection_job_id, source_method, evidence_reference,
            discovery_type, confidence, confidence_score, derivation_rule, evidence_excerpt, last_verified_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,CASE WHEN $11 THEN now() ELSE NULL END)
          ON CONFLICT (normalized_email, source_account_id, source_method) DO UPDATE SET
            collection_job_id = EXCLUDED.collection_job_id, evidence_reference = EXCLUDED.evidence_reference,
            confidence = EXCLUDED.confidence, confidence_score = EXCLUDED.confidence_score,
            derivation_rule = EXCLUDED.derivation_rule, evidence_excerpt = EXCLUDED.evidence_excerpt,
            evidence_status = 'active', last_seen_at = now(),
            last_verified_at = CASE WHEN $11 THEN now() ELSE email_sources.last_verified_at END`,
          [normalized, sourceAccountId, jobId, observation.sourceMethod, observation.evidenceReference,
            observation.discoveryType, observation.confidence, observation.score, observation.derivationRule ?? null,
            observation.evidenceExcerpt ?? null, observation.publiclyDeclared]
        );
      }

      const best = observations.reduce<Confidence | null>((current, item) => !current || confidenceRank[item.confidence]! > confidenceRank[current]! ? item.confidence : current, null);
      const outcome = best === 'confirmed' ? 'confirmed_email_found' : best === 'likely' ? 'likely_email_found' : best === 'unsure' ? 'guessed_unsure_email_found' : 'no_email_found';
      await client.query(
        `INSERT INTO job_results (job_id, source_account_id, person_id, outcome)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (job_id, source_account_id) DO UPDATE SET outcome = EXCLUDED.outcome, processed_at = now(), error_code = NULL`,
        [jobId, sourceAccountId, personId, outcome]
      );
      return { personId, sourceAccountId, isNewUser, newEmails, duplicateEmails, outcome };
    });
  }

  private async emailSuppressed(client: PoolClient, email: string) {
    const domain = email.split('@')[1]!;
    const result = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM suppressions WHERE
        (suppression_type = 'email' AND normalized_value = $1) OR
        (suppression_type = 'domain' AND normalized_value = $2)) AS exists`,
      [email, domain]
    );
    return result.rows[0]!.exists;
  }
}
