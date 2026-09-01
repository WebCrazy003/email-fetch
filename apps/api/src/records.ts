import { Body, ConflictException, Controller, Delete, Get, Injectable, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { createEmailSchema, emailQuerySchema, normalizeEmail, userQuerySchema, type EmailQuery, type UserQuery } from '@email-fetch/shared';
import { z } from 'zod';
import { Database } from './database.js';
import { parseWith } from './http.js';

type SqlFilter = { clauses: string[]; values: unknown[] };

function add(filter: SqlFilter, expression: string, value: unknown) {
  filter.values.push(value);
  filter.clauses.push(expression.replace('?', `$${filter.values.length}`));
}

@Injectable()
export class RecordsService {
  constructor(private readonly db: Database) {}

  async listUsers(query: UserQuery) {
    const filter: SqlFilter = { clauses: [`p.lifecycle_status <> 'deleted'`], values: [] };
    if (query.q) add(filter, `(sa.username ILIKE ? OR sa.display_name ILIKE $${filter.values.length + 1} OR sa.company ILIKE $${filter.values.length + 1} OR EXISTS (SELECT 1 FROM person_email_addresses px WHERE px.person_id = p.id AND px.normalized_email ILIKE $${filter.values.length + 1}))`, `%${query.q}%`);
    if (query.location) add(filter, `sa.location ILIKE ?`, `%${query.location}%`);
    if (query.company) add(filter, `sa.company ILIKE ?`, `%${query.company}%`);
    if (query.jobId) add(filter, `EXISTS (SELECT 1 FROM job_results jr WHERE jr.source_account_id = sa.id AND jr.job_id = ?)`, query.jobId);
    if (query.emailStatus) add(filter, `EXISTS (SELECT 1 FROM person_email_addresses px JOIN email_addresses ex ON ex.normalized_email = px.normalized_email WHERE px.person_id = p.id AND ex.status = ?)`, query.emailStatus);
    if (query.confidence) add(filter, `EXISTS (SELECT 1 FROM person_email_addresses px JOIN email_addresses ex ON ex.normalized_email = px.normalized_email WHERE px.person_id = p.id AND ex.highest_confidence = ?)`, query.confidence);
    if (query.discoveryType) add(filter, `EXISTS (SELECT 1 FROM person_email_addresses px JOIN email_addresses ex ON ex.normalized_email = px.normalized_email WHERE px.person_id = p.id AND ex.best_discovery_type = ?)`, query.discoveryType);
    if (query.suppressed !== undefined) add(filter, `p.is_suppressed = ?`, query.suppressed);
    if (query.sendStatus === 'never_sent') filter.clauses.push(`NOT EXISTS (SELECT 1 FROM person_email_addresses px JOIN email_addresses ex ON ex.normalized_email = px.normalized_email WHERE px.person_id = p.id AND ex.successful_send_count > 0)`);
    if (query.sendStatus === 'sent') filter.clauses.push(`EXISTS (SELECT 1 FROM person_email_addresses px JOIN email_addresses ex ON ex.normalized_email = px.normalized_email WHERE px.person_id = p.id AND ex.successful_send_count > 0)`);
    if (query.sendStatus === 'failed_latest_attempt') filter.clauses.push(`EXISTS (SELECT 1 FROM person_email_addresses px JOIN email_addresses ex ON ex.normalized_email = px.normalized_email WHERE px.person_id = p.id AND ex.last_send_attempt_status = 'failed')`);
    if (query.sendStatus === 'suppressed') filter.clauses.push(`p.is_suppressed = true`);
    const where = filter.clauses.length ? `WHERE ${filter.clauses.join(' AND ')}` : '';
    const sortMap = { last_checked: 'sa.last_checked_at', first_seen: 'sa.first_seen_at', login: 'sa.normalized_username', followers: 'sa.followers' } as const;
    const offset = (query.page - 1) * query.pageSize;
    const listValues = [...filter.values, query.pageSize, offset];
    const rows = await this.db.query(
      `SELECT p.id AS person_id, p.preferred_display_name, p.is_suppressed, p.first_seen_at,
        sa.id AS source_account_id, sa.username, sa.display_name, sa.profile_url, sa.avatar_url,
        sa.bio, sa.company, sa.location, sa.blog_url, sa.followers, sa.public_repos, sa.last_checked_at,
        COALESCE((SELECT json_agg(json_build_object(
          'email', e.normalized_email, 'originalEmail', e.original_email, 'status', e.status,
          'confidence', e.highest_confidence, 'discoveryType', e.best_discovery_type,
          'successfulSendCount', e.successful_send_count, 'lastSentAt', e.last_sent_at
        ) ORDER BY e.normalized_email)
        FROM person_email_addresses pe JOIN email_addresses e ON e.normalized_email = pe.normalized_email
        WHERE pe.person_id = p.id), '[]'::json) AS emails
       FROM people p JOIN source_accounts sa ON sa.person_id = p.id
       ${where}
       ORDER BY ${sortMap[query.sort]} ${query.order.toUpperCase()} NULLS LAST
       LIMIT $${filter.values.length + 1} OFFSET $${filter.values.length + 2}`,
      listValues
    );
    const count = await this.db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM people p JOIN source_accounts sa ON sa.person_id = p.id ${where}`,
      filter.values
    );
    const total = Number(count.rows[0]!.count);
    return { items: rows.rows, page: query.page, pageSize: query.pageSize, total };
  }

  async getUser(id: string) {
    const result = await this.db.query(
      `SELECT p.*, COALESCE(json_agg(DISTINCT jsonb_build_object(
        'id', sa.id, 'username', sa.username, 'displayName', sa.display_name, 'profileUrl', sa.profile_url,
        'bio', sa.bio, 'company', sa.company, 'location', sa.location, 'blogUrl', sa.blog_url,
        'followers', sa.followers, 'publicRepos', sa.public_repos, 'lastCheckedAt', sa.last_checked_at
      )) FILTER (WHERE sa.id IS NOT NULL), '[]') AS accounts,
      COALESCE((SELECT json_agg(json_build_object('email', e.normalized_email, 'originalEmail', e.original_email,
        'status', e.status, 'confidence', e.highest_confidence, 'discoveryType', e.best_discovery_type,
        'successfulSendCount', e.successful_send_count, 'lastSentAt', e.last_sent_at))
        FROM person_email_addresses pe JOIN email_addresses e ON e.normalized_email = pe.normalized_email
        WHERE pe.person_id = p.id), '[]'::json) AS emails
      FROM people p LEFT JOIN source_accounts sa ON sa.person_id = p.id WHERE p.id = $1 GROUP BY p.id`,
      [id]
    );
    if (!result.rows[0]) throw new NotFoundException('User not found');
    return result.rows[0];
  }

  async listEmails(query: EmailQuery) {
    const filter: SqlFilter = { clauses: [], values: [] };
    if (query.q) add(filter, `e.normalized_email ILIKE ?`, `%${query.q}%`);
    if (query.domain) add(filter, `split_part(e.normalized_email, '@', 2) ILIKE ?`, `%${query.domain}%`);
    if (query.country === 'not_specified') filter.clauses.push(`NOT EXISTS (
      SELECT 1 FROM person_email_addresses pe
      JOIN source_accounts sa ON sa.person_id = pe.person_id
      WHERE pe.normalized_email = e.normalized_email AND NULLIF(BTRIM(sa.location), '') IS NOT NULL
    )`);
    else if (query.country) add(filter, `EXISTS (
      SELECT 1 FROM person_email_addresses pe
      JOIN source_accounts sa ON sa.person_id = pe.person_id
      WHERE pe.normalized_email = e.normalized_email AND sa.location ILIKE ?
    )`, `%${query.country}%`);
    if (query.status) add(filter, `e.status = ?`, query.status);
    if (query.confidence) add(filter, `e.highest_confidence = ?`, query.confidence);
    if (query.discoveryType) add(filter, `e.best_discovery_type = ?`, query.discoveryType);
    if (query.sendStatus === 'never_sent') filter.clauses.push(`e.successful_send_count = 0`);
    if (query.sendStatus === 'sent') filter.clauses.push(`e.successful_send_count > 0`);
    if (query.sendStatus === 'failed_latest_attempt') filter.clauses.push(`e.last_send_attempt_status = 'failed'`);
    if (query.sendStatus === 'suppressed') filter.clauses.push(`e.status = 'suppressed'`);
    const where = filter.clauses.length ? `WHERE ${filter.clauses.join(' AND ')}` : '';
    const sortMap = { email: 'e.normalized_email', first_seen: 'e.first_seen_at', last_seen: 'e.last_seen_at', last_sent: 'e.last_sent_at' } as const;
    const offset = (query.page - 1) * query.pageSize;
    const rows = await this.db.query(
      `SELECT e.*, split_part(e.normalized_email, '@', 2) AS domain,
        (SELECT count(*)::int FROM person_email_addresses pe WHERE pe.normalized_email = e.normalized_email) AS person_count,
        COALESCE((SELECT json_agg(json_build_object('id', p.id, 'name', p.preferred_display_name, 'username', sa.username))
          FROM person_email_addresses pe JOIN people p ON p.id = pe.person_id
          LEFT JOIN source_accounts sa ON sa.person_id = p.id
          WHERE pe.normalized_email = e.normalized_email), '[]'::json) AS people
       FROM email_addresses e ${where}
       ORDER BY ${sortMap[query.sort]} ${query.order.toUpperCase()} NULLS LAST
       LIMIT $${filter.values.length + 1} OFFSET $${filter.values.length + 2}`,
      [...filter.values, query.pageSize, offset]
    );
    const count = await this.db.query<{ count: string }>(`SELECT count(*)::text AS count FROM email_addresses e ${where}`, filter.values);
    const total = Number(count.rows[0]!.count);
    return { items: rows.rows, page: query.page, pageSize: query.pageSize, total };
  }

  async createEmail(input: z.infer<typeof createEmailSchema>) {
    const normalized = normalizeEmail(input.email);
    try {
      return await this.db.transaction(async (client) => {
        const exists = await client.query(`SELECT normalized_email FROM email_addresses WHERE normalized_email = $1`, [normalized]);
        if (exists.rows[0]) throw new ConflictException('Email already exists');
        let personId = input.personId;
        if (!personId) {
          const person = await client.query<{ id: string }>(`INSERT INTO people (preferred_display_name) VALUES ('Manual contact') RETURNING id`);
          personId = person.rows[0]!.id;
        }
        await client.query(
          `INSERT INTO email_addresses (normalized_email, original_email, is_publicly_declared, highest_confidence, best_discovery_type)
           VALUES ($1, $2, $3, $4, $5)`,
          [normalized, input.email, input.confidence === 'confirmed', input.confidence, input.discoveryType]
        );
        await client.query(
          `INSERT INTO person_email_addresses (person_id, normalized_email, link_confidence) VALUES ($1, $2, $3)`,
          [personId, normalized, input.confidence]
        );
        await client.query(`INSERT INTO audit_log (action, target_type, target_id) VALUES ('email_created', 'email', $1)`, [normalized]);
        return { normalizedEmail: normalized, personId };
      });
    } catch (error) {
      if (error instanceof ConflictException) throw error;
      throw error;
    }
  }

  async suppressEmail(email: string, reason?: string) {
    const normalized = normalizeEmail(email);
    await this.db.transaction(async (client) => {
      const updated = await client.query(`UPDATE email_addresses SET status = 'suppressed' WHERE normalized_email = $1 RETURNING normalized_email`, [normalized]);
      if (!updated.rows[0]) throw new NotFoundException('Email not found');
      await client.query(
        `INSERT INTO suppressions (suppression_type, normalized_value, reason) VALUES ('email', $1, $2)
         ON CONFLICT DO NOTHING`,
        [normalized, reason ?? null]
      );
      await client.query(`INSERT INTO audit_log (action, target_type, target_id, metadata_json) VALUES ('email_suppressed', 'email', $1, $2::jsonb)`, [normalized, JSON.stringify({ reason })]);
    });
    return { normalizedEmail: normalized, status: 'suppressed' };
  }

  async suppressUser(id: string, reason?: string) {
    await this.db.transaction(async (client) => {
      const person = await client.query(`UPDATE people SET is_suppressed = true, lifecycle_status = 'suppressed', suppressed_at = now(), suppression_reason = $2 WHERE id = $1 RETURNING id`, [id, reason ?? null]);
      if (!person.rows[0]) throw new NotFoundException('User not found');
      await client.query(`UPDATE source_accounts SET is_suppressed = true, suppressed_at = now(), suppression_reason = $2 WHERE person_id = $1`, [id, reason ?? null]);
      await client.query(
        `INSERT INTO suppressions (suppression_type, source_id, normalized_value, reason)
         SELECT 'source_account_id', source_id, external_account_id, $2 FROM source_accounts WHERE person_id = $1
         ON CONFLICT DO NOTHING`,
        [id, reason ?? null]
      );
      await client.query(`INSERT INTO audit_log (action, target_type, target_id, metadata_json) VALUES ('user_suppressed', 'person', $1, $2::jsonb)`, [id, JSON.stringify({ reason })]);
    });
    return this.getUser(id);
  }

  async deleteUser(id: string) {
    await this.db.transaction(async (client) => {
      const removed = await client.query(`DELETE FROM people WHERE id = $1 RETURNING id`, [id]);
      if (!removed.rows[0]) throw new NotFoundException('User not found');
      await client.query(`DELETE FROM email_addresses e WHERE NOT EXISTS (SELECT 1 FROM person_email_addresses pe WHERE pe.normalized_email = e.normalized_email)`);
      await client.query(`INSERT INTO audit_log (action, target_type, target_id) VALUES ('user_deleted', 'person', $1)`, [id]);
    });
    return { deleted: true };
  }
}

const suppressSchema = z.object({ email: z.string().email(), reason: z.string().trim().max(500).optional() });
const userSuppressSchema = z.object({ reason: z.string().trim().max(500).optional() });

@Controller()
export class RecordsController {
  constructor(private readonly records: RecordsService) {}

  @Get('users')
  users(@Query() query: unknown) { return this.records.listUsers(parseWith(userQuerySchema, query)); }

  @Get('users/:id')
  user(@Param('id') id: string) { return this.records.getUser(id); }

  @Post('users/:id/suppress')
  suppressUser(@Param('id') id: string, @Body() body: unknown) {
    const input = parseWith(userSuppressSchema, body);
    return this.records.suppressUser(id, input.reason);
  }

  @Delete('users/:id')
  deleteUser(@Param('id') id: string) { return this.records.deleteUser(id); }

  @Get('emails')
  emails(@Query() query: unknown) { return this.records.listEmails(parseWith(emailQuerySchema, query)); }

  @Post('emails')
  createEmail(@Body() body: unknown) { return this.records.createEmail(parseWith(createEmailSchema, body)); }

  @Post('email-suppressions')
  suppressEmail(@Body() body: unknown) {
    const input = parseWith(suppressSchema, body);
    return this.records.suppressEmail(input.email, input.reason);
  }
}
