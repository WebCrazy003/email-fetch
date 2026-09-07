import { createHash } from 'node:crypto';
import { BadRequestException, Body, Controller, Injectable, Post } from '@nestjs/common';
import { importUsersSchema, normalizeEmail, type ImportUser, type ImportUsersResult } from '@email-fetch/shared';
import { Database } from './database.js';

@Injectable()
export class UserImportService {
  constructor(private readonly db: Database) {}

  async importUsers(users: ImportUser[]): Promise<ImportUsersResult> {
    return this.db.transaction(async (client) => {
      // Serialize imports so simultaneous uploads cannot create duplicate people.
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('external_json_import'))`);
      const source = await client.query<{ id: string }>(
        `INSERT INTO sources (source_key, display_name, adapter_version, enabled, capabilities_json)
         VALUES ('external_json', 'External JSON', '1.0.0', false, '{"import":true}'::jsonb)
         ON CONFLICT (source_key) DO UPDATE SET updated_at = now() RETURNING id`
      );
      const sourceId = source.rows[0]!.id;
      const result = { total: users.length, created: 0, updated: 0, skipped: 0 };
      for (const user of users) {
        const email = normalizeEmail(user.email);
        const identity = createHash('sha256').update(JSON.stringify([user.fetch_source, email])).digest('hex');
        const blocked = await client.query<{ blocked: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM suppressions WHERE
             (suppression_type = 'email' AND normalized_value = $1) OR
             (suppression_type = 'domain' AND normalized_value = $2) OR
             (source_id = $3 AND suppression_type IN ('source_account_id', 'source_username') AND normalized_value = $4)
           ) OR EXISTS (SELECT 1 FROM email_addresses WHERE normalized_email = $1 AND status IN ('suppressed', 'deleted', 'invalid'))
           OR EXISTS (SELECT 1 FROM person_email_addresses pe JOIN people p ON p.id = pe.person_id
             WHERE pe.normalized_email = $1 AND (p.is_suppressed OR p.lifecycle_status IN ('suppressed', 'deleted')))
           OR EXISTS (SELECT 1 FROM source_accounts WHERE source_id = $3 AND external_account_id = $4 AND is_suppressed)
           AS blocked`, [email, email.split('@')[1], sourceId, identity]
        );
        if (blocked.rows[0]!.blocked) { result.skipped += 1; continue; }
        // Claim the email before creating a person. The global unique key also
        // catches duplicates from other sources, this batch, and concurrent writes.
        const addedEmail = await client.query<{ normalized_email: string }>(
          `INSERT INTO email_addresses (normalized_email, original_email, highest_confidence, best_discovery_type)
           VALUES ($1,$2,'unsure','imported')
           ON CONFLICT (normalized_email) DO NOTHING RETURNING normalized_email`, [email, user.email]
        );
        if (!addedEmail.rows[0]) { result.skipped += 1; continue; }
        const existing = await client.query<{ id: string; person_id: string }>(
          `SELECT id, person_id FROM source_accounts WHERE source_id = $1 AND external_account_id = $2 FOR UPDATE`,
          [sourceId, identity]
        );
        let personId = existing.rows[0]?.person_id;
        if (!personId) {
          const person = await client.query<{ id: string }>(
            `INSERT INTO people (preferred_display_name) VALUES ($1) RETURNING id`, [user.name || email]
          );
          personId = person.rows[0]!.id;
          result.created += 1;
        } else {
          await client.query(`UPDATE people SET preferred_display_name = $2, updated_at = now() WHERE id = $1`, [personId, user.name || email]);
          result.updated += 1;
        }
        const account = await client.query<{ id: string }>(
          `INSERT INTO source_accounts (person_id, source_id, external_account_id, normalized_username, username,
             display_name, profile_url, location, bio, attributes_json)
           VALUES ($1,$2,$3,$3,$4,$5,$6,$7,$8,$9::jsonb)
           ON CONFLICT (source_id, external_account_id) DO UPDATE SET
             display_name = EXCLUDED.display_name, profile_url = EXCLUDED.profile_url, location = EXCLUDED.location,
             bio = EXCLUDED.bio, attributes_json = EXCLUDED.attributes_json, last_checked_at = now()
           RETURNING id`,
          [personId, sourceId, identity, email, user.name, user.fetch_page_link, user.country, user.extra_info, JSON.stringify(user)]
        );
        await client.query(
          `INSERT INTO person_email_addresses (person_id, normalized_email) VALUES ($1,$2)
           ON CONFLICT (person_id, normalized_email) DO UPDATE SET last_seen_at = now()`, [personId, email]
        );
        await client.query(
          `INSERT INTO email_sources (normalized_email, source_account_id, source_method, evidence_reference, discovery_type, confidence, evidence_excerpt)
           VALUES ($1,$2,'external_json_import',$3,'imported','unsure',$4)
           ON CONFLICT (normalized_email, source_account_id, source_method) DO UPDATE SET
             evidence_reference = EXCLUDED.evidence_reference, evidence_excerpt = EXCLUDED.evidence_excerpt, last_seen_at = now()`,
          [email, account.rows[0]!.id, user.fetch_page_link || user.fetch_source, user.extra_info]
        );
      }
      await client.query(
        `INSERT INTO audit_log (action, target_type, metadata_json) VALUES ('users_imported', 'person', $1::jsonb)`,
        [JSON.stringify(result)]
      );
      return result;
    });
  }
}

@Controller('users')
export class UserImportController {
  constructor(private readonly imports: UserImportService) {}

  @Post('import')
  importUsers(@Body() body: unknown) {
    const parsed = importUsersSchema.safeParse(body);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((issue) => `Row ${Number(issue.path[0] ?? 0) + 1}, ${issue.path.slice(1).join('.') || 'record'}: ${issue.message}`);
      throw new BadRequestException({ message: issues.slice(0, 10).join('; '), issues: parsed.error.issues });
    }
    return this.imports.importUsers(parsed.data);
  }
}
