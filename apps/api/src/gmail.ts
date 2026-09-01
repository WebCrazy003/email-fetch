import { BadRequestException, Body, Controller, Delete, Get, Injectable, Param, Post, Query, Res } from '@nestjs/common';
import { campaignTestSchema, normalizeEmail, testEmailRecipientSchema } from '@email-fetch/shared';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyReply } from 'fastify';
import { Database } from './database.js';
import { EmailTemplatesService, renderTemplate, withRequiredFooter } from './email-templates.js';
import { parseWith } from './http.js';
import { QueueService } from './queue.service.js';

const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
const OAUTH_SCOPES = ['openid', 'email', GMAIL_SCOPE];

type ProviderConnection = {
  id: string;
  external_account_id: string;
  account_address: string;
  credential_ciphertext: string;
  status: string;
};

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
};

export class GmailProviderError extends Error {
  constructor(message: string, readonly transient: boolean, readonly status?: number) { super(message); }
}

export function parseTestRecipients(...values: Array<string | undefined>): string[] {
  return [...new Set(values
    .flatMap((value) => value?.split(/[,;\n]/) ?? [])
    .map((value) => value.trim())
    .filter(Boolean)
    .map(normalizeEmail))];
}

export function encryptCredential(value: string, encodedKey = process.env.GMAIL_TOKEN_ENCRYPTION_KEY): string {
  const key = encryptionKey(encodedKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.');
}

export function decryptCredential(value: string, encodedKey = process.env.GMAIL_TOKEN_ENCRYPTION_KEY): string {
  const [version, iv, tag, ciphertext] = value.split('.');
  if (version !== 'v1' || !iv || !tag || !ciphertext) throw new Error('Stored Gmail credential is invalid');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(encodedKey), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
}

function encryptionKey(value?: string): Buffer {
  if (!value) throw new Error('GMAIL_TOKEN_ENCRYPTION_KEY is not configured');
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32) throw new Error('GMAIL_TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key');
  return key;
}

function oauthConfig() {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID || process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI ?? 'http://127.0.0.1:3000/api/email-providers/gmail/oauth/callback';
  if (!clientId || !clientSecret) throw new BadRequestException('Google OAuth client ID and secret are not configured');
  return { clientId, clientSecret, redirectUri };
}

@Injectable()
export class GmailService {
  constructor(
    private readonly db: Database,
    private readonly queue: QueueService,
    private readonly templates: EmailTemplatesService
  ) {}

  async status() {
    const fixedTestRecipients = this.environmentTestRecipients();
    const [result, testRecipients] = await Promise.all([this.db.query(
      `SELECT id, account_address, display_label, granted_scopes, status, connected_at, updated_at,
        last_health_check_at, last_error FROM email_provider_connections WHERE provider_key = 'gmail'`
    ), this.configuredTestRecipients()]);
    const connection = result.rows[0];
    return {
      configured: Boolean(
        (process.env.GOOGLE_OAUTH_CLIENT_ID || process.env.GOOGLE_CLIENT_ID)
        && (process.env.GOOGLE_OAUTH_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET)
        && process.env.GMAIL_TOKEN_ENCRYPTION_KEY
      ),
      connected: connection?.status === 'active',
      connection: connection ?? null,
      limits: {
        daily: Math.max(1, Number(process.env.EMAIL_SEND_DAILY_LIMIT ?? 100)),
        hourly: Math.max(1, Number(process.env.EMAIL_SEND_HOURLY_LIMIT ?? 25)),
        minimumDelaySeconds: Math.max(1, Number(process.env.EMAIL_SEND_DELAY_SECONDS ?? 5))
      },
      testRecipientConfigured: testRecipients.length > 0,
      testRecipients,
      fixedTestRecipients
    };
  }

  async authorizationUrl() {
    const config = oauthConfig();
    encryptionKey(process.env.GMAIL_TOKEN_ENCRYPTION_KEY);
    const state = randomUUID();
    await this.queue.connection.set(`gmail_oauth_state:${state}`, 'pending', 'EX', 600, 'NX');
    const params = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      response_type: 'code',
      scope: OAUTH_SCOPES.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state
    });
    return { authorizationUrl: `https://accounts.google.com/o/oauth2/v2/auth?${params}` };
  }

  async handleCallback(code?: string, state?: string) {
    if (!code || !state) throw new BadRequestException('OAuth callback is missing code or state');
    const stateValue = await this.queue.connection.getdel(`gmail_oauth_state:${state}`);
    if (!stateValue) throw new BadRequestException('OAuth state is invalid or expired');
    const config = oauthConfig();
    const tokens = await postForm<TokenResponse>('https://oauth2.googleapis.com/token', {
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: 'authorization_code'
    });
    if (!tokens.access_token) throw new BadRequestException(tokens.error_description ?? tokens.error ?? 'Google did not return an access token');
    const identity = await fetchJson<{ sub?: string; email?: string; email_verified?: boolean }>('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` }
    });
    if (!identity.sub || !identity.email || identity.email_verified === false) throw new BadRequestException('Google did not return a verified sender identity');
    const existing = await this.db.query<{ credential_ciphertext: string | null }>(
      `SELECT credential_ciphertext FROM email_provider_connections WHERE provider_key = 'gmail'`
    );
    const encrypted = tokens.refresh_token ? encryptCredential(tokens.refresh_token) : existing.rows[0]?.credential_ciphertext;
    if (!encrypted) throw new BadRequestException('Google did not return a refresh token; reconnect and grant access again');
    const scopes = (tokens.scope ?? OAUTH_SCOPES.join(' ')).split(' ').filter(Boolean);
    await this.db.query(
      `INSERT INTO email_provider_connections
        (provider_key, external_account_id, account_address, display_label, credential_ciphertext, granted_scopes, status, last_health_check_at)
       VALUES ('gmail', $1, $2, $2, $3, $4, 'active', now())
       ON CONFLICT (provider_key) DO UPDATE SET external_account_id = EXCLUDED.external_account_id,
         account_address = EXCLUDED.account_address, display_label = EXCLUDED.display_label,
         credential_ciphertext = EXCLUDED.credential_ciphertext, granted_scopes = EXCLUDED.granted_scopes,
         status = 'active', last_health_check_at = now(), last_error = NULL, updated_at = now(), disconnected_at = NULL`,
      [identity.sub, identity.email.toLowerCase(), encrypted, scopes]
    );
    await this.audit('gmail_connected', identity.email.toLowerCase());
    return identity.email;
  }

  async disconnect() {
    const result = await this.db.query(
      `UPDATE email_provider_connections SET status = 'disabled', credential_ciphertext = NULL,
        disconnected_at = now(), updated_at = now() WHERE provider_key = 'gmail' RETURNING id`
    );
    if (!result.rows[0]) throw new BadRequestException('No Gmail account is connected');
    await this.audit('gmail_disconnected');
    return { connected: false };
  }

  async test(input: { templateId: string; senderName: string; replyTo: string; recipient?: string }) {
    const testRecipients = await this.configuredTestRecipients();
    if (!testRecipients.length) throw new BadRequestException('No test email recipient is configured');
    const recipient = input.recipient ?? testRecipients[0]!;
    if (!testRecipients.includes(recipient)) throw new BadRequestException('The selected address is not an approved test recipient');
    const template = await this.templates.get(input.templateId, true) as { subject: string; body_text: string };
    const data = { name: 'Test recipient', username: 'test-recipient', email: recipient };
    const result = await this.send({
      to: recipient,
      senderName: input.senderName,
      replyTo: input.replyTo,
      subject: `[TEST] ${renderTemplate(template.subject, data)}`,
      bodyText: withRequiredFooter(renderTemplate(template.body_text, data), input.senderName)
    });
    await this.audit('gmail_test_sent', recipient, { providerMessageId: result.id, templateId: input.templateId });
    return { sent: true, recipient, providerMessageId: result.id };
  }

  async addTestRecipient(input: { email: string }) {
    if (this.environmentTestRecipients().includes(input.email)) {
      throw new BadRequestException('This test recipient is already configured through the environment');
    }
    const result = await this.db.query<{ normalized_email: string }>(
      `INSERT INTO email_test_recipients (normalized_email) VALUES ($1)
       ON CONFLICT (normalized_email) DO NOTHING RETURNING normalized_email`,
      [input.email]
    );
    if (result.rows[0]) await this.audit('gmail_test_recipient_added', input.email);
    return this.status();
  }

  async removeTestRecipient(email: string) {
    if (this.environmentTestRecipients().includes(email)) {
      throw new BadRequestException('Recipients configured through the environment must be removed from .env');
    }
    const result = await this.db.query<{ normalized_email: string }>(
      `DELETE FROM email_test_recipients WHERE normalized_email = $1 RETURNING normalized_email`,
      [email]
    );
    if (!result.rows[0]) throw new BadRequestException('Test recipient was not found');
    await this.audit('gmail_test_recipient_removed', email);
    return this.status();
  }

  async activeConnection(): Promise<ProviderConnection> {
    const result = await this.db.query<ProviderConnection>(
      `SELECT id, external_account_id, account_address, credential_ciphertext, status
       FROM email_provider_connections WHERE provider_key = 'gmail' AND status = 'active' AND credential_ciphertext IS NOT NULL`
    );
    if (!result.rows[0]) throw new GmailProviderError('No active Gmail account is connected', false);
    return result.rows[0];
  }

  async send(message: { to: string; senderName: string; replyTo?: string; subject: string; bodyText: string; messageId?: string }) {
    const connection = await this.activeConnection();
    const accessToken = await this.refreshAccessToken(connection);
    const raw = createMimeMessage({ ...message, from: connection.account_address });
    try {
      const result = await fetchJson<{ id: string; threadId?: string }>('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw: Buffer.from(raw, 'utf8').toString('base64url') })
      });
      await this.db.query(
        `UPDATE email_provider_connections SET status = 'active', last_health_check_at = now(), last_error = NULL, updated_at = now() WHERE id = $1`,
        [connection.id]
      );
      return result;
    } catch (error) {
      if (error instanceof HttpError) {
        const transient = error.status === 429 || error.status >= 500;
        if (error.status === 401 || error.status === 403) {
          await this.db.query(`UPDATE email_provider_connections SET status = 'unhealthy', last_error = $2, updated_at = now() WHERE id = $1`, [connection.id, error.message]);
        }
        throw new GmailProviderError(error.message, transient, error.status);
      }
      throw new GmailProviderError(error instanceof Error ? error.message : 'Gmail request failed', true);
    }
  }

  private async refreshAccessToken(connection: ProviderConnection) {
    const config = oauthConfig();
    let refreshToken: string;
    try { refreshToken = decryptCredential(connection.credential_ciphertext); }
    catch { throw new GmailProviderError('Stored Gmail credential could not be decrypted', false); }
    let tokens: TokenResponse;
    try {
      tokens = await postForm<TokenResponse>('https://oauth2.googleapis.com/token', {
        client_id: config.clientId,
        client_secret: config.clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token'
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Token refresh failed';
      await this.db.query(`UPDATE email_provider_connections SET status = 'unhealthy', last_error = $2, updated_at = now() WHERE id = $1`, [connection.id, message]);
      throw new GmailProviderError(message, error instanceof HttpError && error.status >= 500, error instanceof HttpError ? error.status : undefined);
    }
    if (!tokens.access_token) {
      await this.db.query(`UPDATE email_provider_connections SET status = 'unhealthy', last_error = $2, updated_at = now() WHERE id = $1`, [connection.id, tokens.error_description ?? tokens.error ?? 'Token refresh failed']);
      throw new GmailProviderError(tokens.error_description ?? tokens.error ?? 'Gmail authorization expired', false);
    }
    return tokens.access_token;
  }

  private environmentTestRecipients() {
    return parseTestRecipients(process.env.GMAIL_TEST_RECIPIENTS, process.env.GMAIL_TEST_RECIPIENT);
  }

  private async configuredTestRecipients() {
    const result = await this.db.query<{ normalized_email: string }>(
      `SELECT normalized_email FROM email_test_recipients ORDER BY created_at, normalized_email`
    );
    return [...new Set([...this.environmentTestRecipients(), ...result.rows.map((row) => row.normalized_email)])];
  }

  private audit(action: string, targetId?: string, metadata: unknown = {}) {
    return this.db.query(
      `INSERT INTO audit_log (action, target_type, target_id, metadata_json) VALUES ($1, 'email_provider', $2, $3::jsonb)`,
      [action, targetId ?? null, JSON.stringify(metadata)]
    );
  }
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const nested = body.error && typeof body.error === 'object' ? body.error as Record<string, unknown> : undefined;
    const message = String(nested?.message ?? body.error_description ?? body.error ?? `Request failed (${response.status})`).slice(0, 500);
    throw new HttpError(response.status, message);
  }
  return body as T;
}

function postForm<T>(url: string, values: Record<string, string>) {
  return fetchJson<T>(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(values).toString()
  });
}

function encodeHeader(value: string) {
  if (/[\r\n]/.test(value)) throw new Error('Email header contains a line break');
  return /[^\x20-\x7E]/.test(value) ? `=?UTF-8?B?${Buffer.from(value).toString('base64')}?=` : value;
}

export function createMimeMessage(input: { from: string; to: string; senderName: string; replyTo?: string; subject: string; bodyText: string; messageId?: string }) {
  const headers = [
    `From: ${encodeHeader(input.senderName)} <${input.from}>`,
    `To: ${input.to}`,
    `Subject: ${encodeHeader(input.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${input.messageId ?? randomUUID()}@email-fetch.local>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit'
  ];
  if (input.replyTo) headers.splice(2, 0, `Reply-To: ${input.replyTo}`);
  return `${headers.join('\r\n')}\r\n\r\n${input.bodyText.replace(/\r?\n/g, '\r\n')}`;
}

@Controller('email-providers')
export class GmailController {
  constructor(private readonly gmail: GmailService) {}

  @Get('gmail/status')
  status() { return this.gmail.status(); }

  @Post('gmail/connect')
  connect() { return this.gmail.authorizationUrl(); }

  @Get('gmail/oauth/callback')
  async callback(@Query('code') code: string | undefined, @Query('state') state: string | undefined, @Query('error') error: string | undefined, @Res() reply: FastifyReply) {
    try {
      if (error) throw new BadRequestException(`Google authorization failed: ${error}`);
      await this.gmail.handleCallback(code, state);
      return reply.redirect('http://127.0.0.1:8080/settings?gmail=connected');
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'OAuth connection failed';
      return reply.redirect(`http://127.0.0.1:8080/settings?gmail=error&message=${encodeURIComponent(message)}`);
    }
  }

  @Post('gmail/test')
  test(@Body() body: unknown) { return this.gmail.test(parseWith(campaignTestSchema, body)); }

  @Post('gmail/test-recipients')
  addTestRecipient(@Body() body: unknown) { return this.gmail.addTestRecipient(parseWith(testEmailRecipientSchema, body)); }

  @Delete('gmail/test-recipients/:recipient')
  removeTestRecipient(@Param('recipient') recipient: string) {
    const input = parseWith(testEmailRecipientSchema, { email: recipient });
    return this.gmail.removeTestRecipient(input.email);
  }

  @Post('gmail/disconnect')
  disconnect() { return this.gmail.disconnect(); }
}
