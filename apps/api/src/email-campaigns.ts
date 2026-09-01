import { BadRequestException, Body, ConflictException, Controller, Get, Injectable, MessageEvent, NotFoundException, Param, Post, Query, Sse } from '@nestjs/common';
import { campaignSelectionSchema, createEmailCampaignSchema, normalizeEmail, type CreateEmailCampaignInput } from '@email-fetch/shared';
import { concatMap, from, interval, map, Observable, startWith } from 'rxjs';
import { Database } from './database.js';
import { EmailTemplatesService, renderTemplate, withRequiredFooter } from './email-templates.js';
import { GmailProviderError, GmailService } from './gmail.js';
import { parseWith } from './http.js';
import { QueueService } from './queue.service.js';

type SelectionRow = {
  normalized_email: string;
  original_email: string;
  status: string;
  successful_send_count: number;
  person_id: string | null;
  person_name: string | null;
  username: string | null;
  person_suppressed: boolean;
  explicitly_suppressed: boolean;
  highest_confidence: string;
  best_discovery_type: string;
};

type RecipientState = 'queued' | 'skipped_suppressed' | 'skipped_invalid' | 'skipped_already_sent';

function eligibility(row: SelectionRow): { state: RecipientState; reason?: string } {
  if (row.status === 'suppressed' || row.person_suppressed || row.explicitly_suppressed) return { state: 'skipped_suppressed', reason: 'Recipient is suppressed' };
  if (row.status !== 'active') return { state: 'skipped_invalid', reason: `Email status is ${row.status}` };
  if (row.successful_send_count > 0) return { state: 'skipped_already_sent', reason: 'Repeat contact is disabled' };
  return { state: 'queued' };
}

const terminalStates = ['sent', 'failed', 'skipped_suppressed', 'skipped_invalid', 'skipped_already_sent', 'skipped_policy', 'cancelled'];

@Injectable()
export class EmailCampaignsService {
  constructor(
    private readonly db: Database,
    private readonly queue: QueueService,
    private readonly templates: EmailTemplatesService,
    private readonly gmail: GmailService
  ) {}

  async preview(emailIds: string[]) {
    const rows = await this.selectionRows(emailIds);
    const found = new Map(rows.map((row) => [row.normalized_email, row]));
    const recipients = emailIds.map((email) => {
      const normalized = normalizeEmail(email);
      const row = found.get(normalized);
      if (!row) return { normalized_email: normalized, state: 'skipped_invalid', reason: 'Email record no longer exists' };
      return { ...row, ...eligibility(row) };
    });
    return {
      selected: emailIds.length,
      eligible: recipients.filter((item) => item.state === 'queued').length,
      excluded: recipients.filter((item) => item.state !== 'queued').length,
      recipients
    };
  }

  async create(input: CreateEmailCampaignInput) {
    const [template, connection, preview, active, usage] = await Promise.all([
      this.templates.get(input.templateId, true) as Promise<{ id: string; revision: number; subject: string; body_text: string }>,
      this.gmail.activeConnection(),
      this.preview(input.emailIds),
      this.db.query(`SELECT id FROM email_campaigns WHERE state IN ('queued','sending','paused','provider_limited','cancelling') LIMIT 1`),
      this.db.query<{ sent_day: string; sent_hour: string }>(
        `SELECT count(*) FILTER (WHERE sent_at > now() - interval '24 hours')::text AS sent_day,
          count(*) FILTER (WHERE sent_at > now() - interval '1 hour')::text AS sent_hour
         FROM campaign_recipients WHERE state = 'sent'`
      )
    ]);
    if (active.rows[0]) throw new ConflictException('Finish or cancel the active email campaign before starting another');
    if (preview.eligible === 0) throw new BadRequestException('None of the selected emails are eligible to send');
    const dailyLimit = Math.max(1, Number(process.env.EMAIL_SEND_DAILY_LIMIT ?? 100));
    const sentToday = Number(usage.rows[0]?.sent_day ?? 0);
    const sentThisHour = Number(usage.rows[0]?.sent_hour ?? 0);
    if (sentToday + preview.eligible > dailyLimit) {
      throw new ConflictException(`Daily safety cap allows ${Math.max(0, dailyLimit - sentToday)} more emails in the current rolling 24-hour window`);
    }
    const selectionRows = await this.selectionRows(input.emailIds);
    if (selectionRows.length !== input.emailIds.length) throw new BadRequestException('One or more selected email records no longer exist');
    const rowsByEmail = new Map(selectionRows.map((row) => [row.normalized_email, row]));
    const created = await this.db.transaction(async (client) => {
      const campaign = await client.query<{ id: string }>(
        `INSERT INTO email_campaigns
          (name, template_id, template_revision, provider_connection_id, state, sender_name, sender_address,
           reply_to, subject, body_text, purpose, selection_snapshot_json, counters_json)
         VALUES ($1,$2,$3,$4,'queued',$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb) RETURNING id`,
        [input.name, template.id, template.revision, connection.id, input.senderName, connection.account_address,
          input.replyTo || null, template.subject, withRequiredFooter(template.body_text, input.senderName), input.purpose, JSON.stringify(input.emailIds),
          JSON.stringify({ selected: input.emailIds.length, eligible: preview.eligible, queued: preview.eligible, sent: 0, failed: 0, skipped: preview.excluded, cancelled: 0 })]
      );
      const campaignId = campaign.rows[0]!.id;
      const queued: Array<{ id: string; campaignId: string }> = [];
      for (const email of input.emailIds) {
        const row = rowsByEmail.get(normalizeEmail(email))!;
        const eligible = eligibility(row);
        const terminal = eligible.state === 'queued' ? null : 'skipped';
        const recipient = await client.query<{ id: string }>(
          `INSERT INTO campaign_recipients
            (campaign_id, person_id, normalized_email, recipient_address_snapshot, merge_data_json,
             state, terminal_result, skip_failure_reason, idempotency_key, queued_at)
           VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,CASE WHEN $6 = 'queued' THEN now() ELSE NULL END)
           RETURNING id`,
          [campaignId, row.person_id, row.normalized_email, row.original_email,
            JSON.stringify({
              name: row.person_name || row.username || row.normalized_email.split('@')[0],
              username: row.username || '',
              email: row.normalized_email
            }), eligible.state, terminal, eligible.reason ?? null, `${campaignId}:${row.normalized_email}`]
        );
        if (eligible.state === 'queued') queued.push({ id: recipient.rows[0]!.id, campaignId });
      }
      await client.query(
        `INSERT INTO campaign_events (campaign_id, level, event_type, message, metadata_json)
         VALUES ($1, 'info', 'campaign_queued', 'Campaign queued for automatic sending', $2::jsonb)`,
        [campaignId, JSON.stringify({ selected: input.emailIds.length, eligible: preview.eligible, templateRevision: template.revision })]
      );
      await client.query(
        `INSERT INTO audit_log (action, target_type, target_id, metadata_json)
         VALUES ('email_campaign_started', 'email_campaign', $1, $2::jsonb)`,
        [campaignId, JSON.stringify({ selected: input.emailIds.length, eligible: preview.eligible, templateId: template.id })]
      );
      return { campaignId, queued };
    });
    try {
      for (const [index, recipient] of created.queued.entries()) {
        await this.queue.enqueueEmail(recipient.id, recipient.campaignId, deliveryDelay(index, sentThisHour));
      }
    } catch (error) {
      await this.db.query(
        `UPDATE email_campaigns SET state = 'failed', completed_at = now(), updated_at = now(), failure_message = $2 WHERE id = $1`,
        [created.campaignId, error instanceof Error ? error.message.slice(0, 500) : 'Could not queue recipients']
      );
      throw error;
    }
    return this.get(created.campaignId);
  }

  async list(page = 1, pageSize = 25) {
    const safePage = Math.max(1, page); const safeSize = Math.min(100, Math.max(1, pageSize));
    const [rows, count] = await Promise.all([
      this.db.query(
        `SELECT c.*, t.name AS template_name FROM email_campaigns c LEFT JOIN email_templates t ON t.id = c.template_id
         ORDER BY c.created_at DESC LIMIT $1 OFFSET $2`,
        [safeSize, (safePage - 1) * safeSize]
      ),
      this.db.query<{ count: string }>(`SELECT count(*)::text AS count FROM email_campaigns`)
    ]);
    return { items: rows.rows, page: safePage, pageSize: safeSize, total: Number(count.rows[0]!.count) };
  }

  async get(id: string) {
    const result = await this.db.query(
      `SELECT c.*, t.name AS template_name, p.account_address,
        COALESCE((SELECT json_agg(e ORDER BY e.created_at DESC) FROM (
          SELECT id, recipient_id, level, event_type, message, metadata_json, created_at
          FROM campaign_events WHERE campaign_id = c.id ORDER BY created_at DESC LIMIT 50
        ) e), '[]'::json) AS recent_events
       FROM email_campaigns c LEFT JOIN email_templates t ON t.id = c.template_id
       JOIN email_provider_connections p ON p.id = c.provider_connection_id WHERE c.id = $1`,
      [id]
    );
    if (!result.rows[0]) throw new NotFoundException('Email campaign not found');
    return result.rows[0];
  }

  async recipients(id: string, page = 1, pageSize = 25) {
    await this.get(id);
    const safePage = Math.max(1, page); const safeSize = Math.min(100, Math.max(1, pageSize));
    const [rows, count] = await Promise.all([
      this.db.query(
        `SELECT id, normalized_email, recipient_address_snapshot, merge_data_json, state, terminal_result,
          skip_failure_reason, attempt_count, provider_message_id, sent_at, failed_at, created_at
         FROM campaign_recipients WHERE campaign_id = $1 ORDER BY created_at LIMIT $2 OFFSET $3`,
        [id, safeSize, (safePage - 1) * safeSize]
      ),
      this.db.query<{ count: string }>(`SELECT count(*)::text AS count FROM campaign_recipients WHERE campaign_id = $1`, [id])
    ]);
    return { items: rows.rows, page: safePage, pageSize: safeSize, total: Number(count.rows[0]!.count) };
  }

  async events(id: string) {
    await this.get(id);
    const result = await this.db.query(
      `SELECT id, recipient_id, level, event_type, message, metadata_json, created_at
       FROM campaign_events WHERE campaign_id = $1 ORDER BY created_at DESC LIMIT 100`, [id]
    );
    return result.rows;
  }

  async pause(id: string) {
    const result = await this.db.query(
      `UPDATE email_campaigns SET state = 'paused', updated_at = now() WHERE id = $1 AND state IN ('queued','sending','provider_limited') RETURNING id`,
      [id]
    );
    if (!result.rows[0]) return this.get(id);
    await this.queue.emailSend.pause();
    await this.event(id, 'info', 'campaign_paused', 'Campaign paused');
    return this.get(id);
  }

  async resume(id: string) {
    const result = await this.db.query(
      `UPDATE email_campaigns SET state = 'queued', updated_at = now() WHERE id = $1 AND state IN ('paused','provider_limited') RETURNING id`,
      [id]
    );
    if (!result.rows[0]) return this.get(id);
    await this.queue.emailSend.resume();
    await this.event(id, 'info', 'campaign_resumed', 'Campaign resumed');
    return this.get(id);
  }

  async cancel(id: string) {
    const campaign = await this.get(id) as { state: string };
    if (!['queued', 'sending', 'paused', 'provider_limited'].includes(campaign.state)) return campaign;
    await this.db.transaction(async (client) => {
      await client.query(
        `UPDATE email_campaigns SET state = 'cancelled', cancellation_requested_at = now(), completed_at = now(), updated_at = now() WHERE id = $1`, [id]
      );
      await client.query(
        `UPDATE campaign_recipients SET state = 'cancelled', terminal_result = 'cancelled', updated_at = now()
         WHERE campaign_id = $1 AND state IN ('selected','queued','retry_wait')`, [id]
      );
      await client.query(
        `INSERT INTO campaign_events (campaign_id, level, event_type, message) VALUES ($1, 'info', 'campaign_cancelled', 'Campaign cancelled')`, [id]
      );
      await client.query(
        `INSERT INTO audit_log (action, target_type, target_id) VALUES ('email_campaign_cancelled', 'email_campaign', $1)`, [id]
      );
    });
    await this.queue.emailSend.resume();
    await refreshCampaign(this.db, id);
    return this.get(id);
  }

  private async selectionRows(emailIds: string[]) {
    const result = await this.db.query<SelectionRow>(
      `SELECT e.normalized_email, e.original_email, e.status, e.successful_send_count,
        e.highest_confidence, e.best_discovery_type,
        chosen.person_id, chosen.person_name, chosen.username,
        COALESCE(chosen.person_suppressed, false) AS person_suppressed,
        EXISTS (SELECT 1 FROM suppressions s WHERE s.suppression_type = 'email' AND s.normalized_value = e.normalized_email) AS explicitly_suppressed
       FROM email_addresses e
       LEFT JOIN LATERAL (
         SELECT p.id AS person_id, COALESCE(p.preferred_display_name, sa.display_name) AS person_name,
           sa.username, (p.is_suppressed OR p.lifecycle_status <> 'active' OR COALESCE(sa.is_suppressed, false)) AS person_suppressed
         FROM person_email_addresses pe JOIN people p ON p.id = pe.person_id
         LEFT JOIN source_accounts sa ON sa.person_id = p.id
         WHERE pe.normalized_email = e.normalized_email
         ORDER BY p.is_suppressed ASC, p.first_seen_at ASC LIMIT 1
       ) chosen ON true
       WHERE e.normalized_email = ANY($1::text[])`,
      [emailIds.map(normalizeEmail)]
    );
    return result.rows;
  }

  private event(campaignId: string, level: string, type: string, message: string, metadata: unknown = {}) {
    return this.db.query(
      `INSERT INTO campaign_events (campaign_id, level, event_type, message, metadata_json) VALUES ($1,$2,$3,$4,$5::jsonb)`,
      [campaignId, level, type, message, JSON.stringify(metadata)]
    );
  }
}

function deliveryDelay(index: number, alreadySentThisHour: number) {
  const hourly = Math.max(1, Number(process.env.EMAIL_SEND_HOURLY_LIMIT ?? 25));
  const delay = Math.max(1, Number(process.env.EMAIL_SEND_DELAY_SECONDS ?? 5)) * 1_000;
  const position = index + alreadySentThisHour;
  return Math.floor(position / hourly) * 3_600_000 + (position % hourly) * delay;
}

@Injectable()
export class EmailCampaignSender {
  constructor(private readonly db: Database, private readonly gmail: GmailService) {}

  async process(recipientId: string) {
    const loaded = await this.db.query<{
      id: string; campaign_id: string; normalized_email: string; recipient_address_snapshot: string;
      merge_data_json: Record<string, string>; state: string; provider_message_id: string | null;
      campaign_state: string; sender_name: string; reply_to: string | null; subject: string; body_text: string;
      email_status: string | null; successful_send_count: number | null; suppressed: boolean;
    }>(
      `SELECT r.id, r.campaign_id, r.normalized_email, r.recipient_address_snapshot, r.merge_data_json,
        r.state, r.provider_message_id, c.state AS campaign_state, c.sender_name, c.reply_to, c.subject, c.body_text,
        e.status AS email_status, e.successful_send_count,
        EXISTS (SELECT 1 FROM suppressions s WHERE s.suppression_type = 'email' AND s.normalized_value = r.normalized_email) AS suppressed
       FROM campaign_recipients r JOIN email_campaigns c ON c.id = r.campaign_id
       LEFT JOIN email_addresses e ON e.normalized_email = r.normalized_email WHERE r.id = $1`,
      [recipientId]
    );
    const recipient = loaded.rows[0];
    if (!recipient) return;
    if (recipient.provider_message_id || terminalStates.includes(recipient.state)) return;
    if (recipient.campaign_state === 'cancelled' || recipient.campaign_state === 'cancelling') {
      await this.skip(recipient, 'cancelled', 'cancelled', 'Campaign was cancelled');
      return;
    }
    if (recipient.campaign_state === 'paused') throw new GmailProviderError('Campaign is paused', true);
    if (recipient.email_status === 'suppressed' || recipient.suppressed) {
      await this.skip(recipient, 'skipped_suppressed', 'skipped', 'Recipient became suppressed');
      return;
    }
    if (recipient.email_status !== 'active') {
      await this.skip(recipient, 'skipped_invalid', 'skipped', 'Recipient is no longer active');
      return;
    }
    if ((recipient.successful_send_count ?? 0) > 0) {
      await this.skip(recipient, 'skipped_already_sent', 'skipped', 'Repeat contact is disabled');
      return;
    }
    await this.db.query(
      `UPDATE campaign_recipients SET state = 'sending', attempt_count = attempt_count + 1,
        first_attempt_at = COALESCE(first_attempt_at, now()), updated_at = now() WHERE id = $1`, [recipient.id]
    );
    await this.db.query(
      `UPDATE email_campaigns SET state = 'sending', started_at = COALESCE(started_at, now()), updated_at = now()
       WHERE id = $1 AND state IN ('queued','provider_limited')`, [recipient.campaign_id]
    );
    const subject = renderTemplate(recipient.subject, recipient.merge_data_json);
    const bodyText = renderTemplate(recipient.body_text, recipient.merge_data_json);
    const sent = await this.gmail.send({
      to: recipient.recipient_address_snapshot,
      senderName: recipient.sender_name,
      replyTo: recipient.reply_to ?? undefined,
      subject,
      bodyText,
      messageId: recipient.id
    });
    await this.db.transaction(async (client) => {
      const updated = await client.query(
        `UPDATE campaign_recipients SET state = 'sent', terminal_result = 'sent', provider_message_id = $2,
          provider_thread_id = $3, sent_at = now(), next_retry_at = NULL, updated_at = now()
         WHERE id = $1 AND provider_message_id IS NULL RETURNING id`,
        [recipient.id, sent.id, sent.threadId ?? null]
      );
      if (updated.rows[0]) {
        await client.query(
          `UPDATE email_addresses SET successful_send_count = successful_send_count + 1, last_sent_at = now(),
            last_sent_campaign_id = $2, last_send_attempt_status = 'sent', last_send_attempt_at = now()
           WHERE normalized_email = $1`, [recipient.normalized_email, recipient.campaign_id]
        );
        await client.query(
          `INSERT INTO campaign_events (campaign_id, recipient_id, level, event_type, message, metadata_json)
           VALUES ($1,$2,'info','recipient_sent','Email accepted by Gmail',$3::jsonb)`,
          [recipient.campaign_id, recipient.id, JSON.stringify({ providerMessageId: sent.id })]
        );
        await client.query(
          `INSERT INTO audit_log (action, target_type, target_id, metadata_json)
           VALUES ('email_sent', 'campaign_recipient', $1, $2::jsonb)`,
          [recipient.id, JSON.stringify({ campaignId: recipient.campaign_id, normalizedEmail: recipient.normalized_email })]
        );
      }
    });
    await refreshCampaign(this.db, recipient.campaign_id);
  }

  async failure(recipientId: string, error: unknown, willRetry: boolean) {
    const loaded = await this.db.query<{ campaign_id: string; normalized_email: string }>(
      `SELECT campaign_id, normalized_email FROM campaign_recipients WHERE id = $1`, [recipientId]
    );
    const recipient = loaded.rows[0];
    if (!recipient) return;
    const message = error instanceof Error ? error.message.slice(0, 500) : 'Gmail send failed';
    if (willRetry) {
      if (error instanceof GmailProviderError && error.status === 429) {
        await this.db.query(`UPDATE email_campaigns SET state = 'provider_limited', updated_at = now() WHERE id = $1`, [recipient.campaign_id]);
      }
      await this.db.query(
        `UPDATE campaign_recipients SET state = 'retry_wait', skip_failure_reason = $2,
          next_retry_at = now() + interval '5 seconds', updated_at = now() WHERE id = $1`, [recipientId, message]
      );
      await this.event(recipient.campaign_id, recipientId, 'warning', 'recipient_retry_wait', 'Email send will retry', { reason: message });
      return;
    }
    await this.db.transaction(async (client) => {
      await client.query(
        `UPDATE campaign_recipients SET state = 'failed', terminal_result = 'failed', skip_failure_reason = $2,
          failed_at = now(), next_retry_at = NULL, updated_at = now() WHERE id = $1`, [recipientId, message]
      );
      await client.query(
        `UPDATE email_addresses SET last_send_attempt_status = 'failed', last_send_attempt_at = now() WHERE normalized_email = $1`,
        [recipient.normalized_email]
      );
      await client.query(
        `INSERT INTO campaign_events (campaign_id, recipient_id, level, event_type, message, metadata_json)
         VALUES ($1,$2,'error','recipient_failed','Email send failed',$3::jsonb)`,
        [recipient.campaign_id, recipientId, JSON.stringify({ reason: message })]
      );
    });
    await refreshCampaign(this.db, recipient.campaign_id);
  }

  private async skip(recipient: { id: string; campaign_id: string }, state: string, result: string, reason: string) {
    await this.db.query(
      `UPDATE campaign_recipients SET state = $2, terminal_result = $3, skip_failure_reason = $4, updated_at = now() WHERE id = $1`,
      [recipient.id, state, result, reason]
    );
    await this.event(recipient.campaign_id, recipient.id, 'info', 'recipient_skipped', reason);
    await refreshCampaign(this.db, recipient.campaign_id);
  }

  private event(campaignId: string, recipientId: string, level: string, type: string, message: string, metadata: unknown = {}) {
    return this.db.query(
      `INSERT INTO campaign_events (campaign_id, recipient_id, level, event_type, message, metadata_json)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb)`, [campaignId, recipientId, level, type, message, JSON.stringify(metadata)]
    );
  }
}

async function refreshCampaign(db: Database, campaignId: string) {
  const result = await db.query<{
    total: string; queued: string; sending: string; sent: string; failed: string; skipped: string; cancelled: string;
  }>(
    `SELECT count(*)::text AS total,
      count(*) FILTER (WHERE state IN ('selected','queued','retry_wait'))::text AS queued,
      count(*) FILTER (WHERE state = 'sending')::text AS sending,
      count(*) FILTER (WHERE state = 'sent')::text AS sent,
      count(*) FILTER (WHERE state = 'failed')::text AS failed,
      count(*) FILTER (WHERE state LIKE 'skipped_%')::text AS skipped,
      count(*) FILTER (WHERE state = 'cancelled')::text AS cancelled
     FROM campaign_recipients WHERE campaign_id = $1`, [campaignId]
  );
  const counts = Object.fromEntries(Object.entries(result.rows[0]!).map(([key, value]) => [key, Number(value)]));
  const remaining = counts.queued! + counts.sending!;
  const current = await db.query<{ state: string }>(`SELECT state FROM email_campaigns WHERE id = $1`, [campaignId]);
  let state = current.rows[0]?.state;
  if (remaining === 0 && state !== 'cancelled') state = counts.failed! > 0 ? 'completed_with_errors' : 'completed';
  await db.query(
    `UPDATE email_campaigns SET counters_json = $2::jsonb, state = $3,
      completed_at = CASE WHEN $4 THEN COALESCE(completed_at, now()) ELSE completed_at END, updated_at = now() WHERE id = $1`,
    [campaignId, JSON.stringify({ selected: counts.total, eligible: counts.total! - counts.skipped!, ...counts }), state, remaining === 0]
  );
}

@Controller('email-campaigns')
export class EmailCampaignsController {
  constructor(private readonly campaigns: EmailCampaignsService) {}

  @Post('selections')
  preview(@Body() body: unknown) { return this.campaigns.preview(parseWith(campaignSelectionSchema, body).emailIds); }

  @Post()
  create(@Body() body: unknown) { return this.campaigns.create(parseWith(createEmailCampaignSchema, body)); }

  @Get()
  list(@Query('page') page?: string, @Query('pageSize') pageSize?: string) { return this.campaigns.list(Number(page ?? 1), Number(pageSize ?? 25)); }

  @Get(':id')
  get(@Param('id') id: string) { return this.campaigns.get(id); }

  @Get(':id/recipients')
  recipients(@Param('id') id: string, @Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return this.campaigns.recipients(id, Number(page ?? 1), Number(pageSize ?? 25));
  }

  @Get(':id/events')
  events(@Param('id') id: string) { return this.campaigns.events(id); }

  @Post(':id/pause')
  pause(@Param('id') id: string) { return this.campaigns.pause(id); }

  @Post(':id/resume')
  resume(@Param('id') id: string) { return this.campaigns.resume(id); }

  @Post(':id/cancel')
  cancel(@Param('id') id: string) { return this.campaigns.cancel(id); }

  @Sse(':id/stream')
  stream(@Param('id') id: string): Observable<MessageEvent> {
    return interval(1_000).pipe(startWith(0), concatMap(() => from(this.campaigns.get(id))), map((data) => ({ data, type: 'campaign' })));
  }
}
