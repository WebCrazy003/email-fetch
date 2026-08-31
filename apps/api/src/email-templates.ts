import { Body, ConflictException, Controller, Delete, Get, Injectable, NotFoundException, Param, Patch, Post, Query } from '@nestjs/common';
import { emailTemplateInputSchema, type EmailTemplateInput } from '@email-fetch/shared';
import { Database } from './database.js';
import { parseWith } from './http.js';

export const TEMPLATE_FIELDS = ['name', 'username', 'email'] as const;

export function templateVariables(value: string): string[] {
  return [...value.matchAll(/{{\s*([^{}]+?)\s*}}/g)].map((match) => match[1]!.trim());
}

export function validateTemplateVariables(subject: string, bodyText: string) {
  const unknown = [...new Set([...templateVariables(subject), ...templateVariables(bodyText)])]
    .filter((field) => !(TEMPLATE_FIELDS as readonly string[]).includes(field));
  if (unknown.length) throw new ConflictException(`Unknown merge fields: ${unknown.join(', ')}`);
}

export function renderTemplate(value: string, data: Record<string, string>): string {
  return value.replace(/{{\s*([^{}]+?)\s*}}/g, (_match, field: string) => data[field.trim()] ?? '');
}

export function withRequiredFooter(bodyText: string, senderName: string): string {
  const optOut = process.env.EMAIL_OPT_OUT_TEXT ?? 'To opt out of future emails, reply with "unsubscribe".';
  return `${bodyText.trim()}\n\n--\n${senderName}\n${optOut}`;
}

@Injectable()
export class EmailTemplatesService {
  constructor(private readonly db: Database) {}

  async list(includeArchived = false) {
    const result = await this.db.query(
      `SELECT id, name, description, subject, body_text, revision, status, created_at, updated_at, archived_at
       FROM email_templates ${includeArchived ? '' : "WHERE status = 'active'"}
       ORDER BY updated_at DESC`
    );
    return result.rows;
  }

  async get(id: string, activeOnly = false) {
    const result = await this.db.query(
      `SELECT id, name, description, subject, body_text, revision, status, created_at, updated_at, archived_at
       FROM email_templates WHERE id = $1${activeOnly ? " AND status = 'active'" : ''}`,
      [id]
    );
    if (!result.rows[0]) throw new NotFoundException('Email template not found');
    return result.rows[0];
  }

  async create(input: EmailTemplateInput) {
    validateTemplateVariables(input.subject, input.bodyText);
    try {
      const result = await this.db.query<{ id: string }>(
        `INSERT INTO email_templates (name, description, subject, body_text)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [input.name, input.description, input.subject, input.bodyText]
      );
      await this.audit('email_template_created', result.rows[0]!.id, { name: input.name });
      return this.get(result.rows[0]!.id);
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException('An active template already uses this name');
      throw error;
    }
  }

  async update(id: string, input: EmailTemplateInput) {
    validateTemplateVariables(input.subject, input.bodyText);
    try {
      const result = await this.db.query<{ id: string }>(
        `UPDATE email_templates SET name = $2, description = $3, subject = $4, body_text = $5,
           revision = revision + 1, updated_at = now()
         WHERE id = $1 AND status = 'active' RETURNING id`,
        [id, input.name, input.description, input.subject, input.bodyText]
      );
      if (!result.rows[0]) throw new NotFoundException('Active email template not found');
      await this.audit('email_template_updated', id, { name: input.name });
      return this.get(id);
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException('An active template already uses this name');
      throw error;
    }
  }

  async duplicate(id: string) {
    const source = await this.get(id) as { name: string; description: string; subject: string; body_text: string };
    let suffix = 1;
    while (suffix < 100) {
      try {
        return await this.create({
          name: `${source.name} copy${suffix === 1 ? '' : ` ${suffix}`}`,
          description: source.description,
          subject: source.subject,
          bodyText: source.body_text
        });
      } catch (error) {
        if (!(error instanceof ConflictException)) throw error;
        suffix += 1;
      }
    }
    throw new ConflictException('Could not create a unique template copy name');
  }

  async remove(id: string) {
    const result = await this.db.query<{ id: string }>(
      `UPDATE email_templates SET status = 'archived', archived_at = now(), updated_at = now()
       WHERE id = $1 AND status = 'active' RETURNING id`,
      [id]
    );
    if (!result.rows[0]) throw new NotFoundException('Active email template not found');
    await this.audit('email_template_archived', id);
    return { id, status: 'archived' };
  }

  private audit(action: string, id: string, metadata: unknown = {}) {
    return this.db.query(
      `INSERT INTO audit_log (action, target_type, target_id, metadata_json) VALUES ($1, 'email_template', $2, $3::jsonb)`,
      [action, id, JSON.stringify(metadata)]
    );
  }
}

function isUniqueViolation(error: unknown): error is { code: string } {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

@Controller('email-templates')
export class EmailTemplatesController {
  constructor(private readonly templates: EmailTemplatesService) {}

  @Get()
  list(@Query('includeArchived') includeArchived?: string) { return this.templates.list(includeArchived === 'true'); }

  @Get(':id')
  get(@Param('id') id: string) { return this.templates.get(id); }

  @Post()
  create(@Body() body: unknown) { return this.templates.create(parseWith(emailTemplateInputSchema, body)); }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: unknown) { return this.templates.update(id, parseWith(emailTemplateInputSchema, body)); }

  @Post(':id/duplicate')
  duplicate(@Param('id') id: string) { return this.templates.duplicate(id); }

  @Delete(':id')
  remove(@Param('id') id: string) { return this.templates.remove(id); }
}
