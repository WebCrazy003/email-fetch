import { BadRequestException } from '@nestjs/common';
import { importUsersSchema } from '@email-fetch/shared';
import { describe, expect, it, vi } from 'vitest';
import type { Database } from './database.js';
import { UserImportController, UserImportService } from './user-import.js';

const user = {
  name: 'Jane Doe', email: 'Jane@Example.com', country: 'Poland', extra_info: 'Developer',
  fetch_source: 'github_hire_me', fetch_page_link: 'https://github.com/jane'
};

function fixture({ existing = false, existingEmail = false, blocked = false, failEmail = false } = {}) {
  const queries: Array<{ sql: string; values: unknown[] }> = [];
  const accounts = new Map<string, { id: string; person_id: string }>();
  const emails = new Set(existingEmail ? ['jane@example.com'] : []);
  let people = 0;
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    queries.push({ sql, values });
    if (sql.includes('INSERT INTO sources')) return { rows: [{ id: 'source-id' }] };
    if (sql.includes('AS blocked')) return { rows: [{ blocked }] };
    if (sql.includes('SELECT id, person_id FROM source_accounts')) return { rows: existing ? [{ id: 'account-id', person_id: 'person-id' }] : [accounts.get(String(values[1]))].filter(Boolean) };
    if (sql.includes('INSERT INTO people')) return { rows: [{ id: `person-${++people}` }] };
    if (sql.includes('INSERT INTO source_accounts')) {
      const account = { id: `account-${values[2]}`, person_id: String(values[0]) };
      accounts.set(String(values[2]), account);
      return { rows: [account] };
    }
    if (sql.includes('INSERT INTO email_addresses')) {
      if (failEmail) throw new Error('Database unavailable');
      const email = String(values[0]);
      if (emails.has(email)) return { rows: [] };
      emails.add(email);
      return { rows: [{ normalized_email: email }] };
    }
    return { rows: [] };
  });
  const transaction = vi.fn(async (work: (client: { query: typeof query }) => Promise<unknown>) => work({ query }));
  const service = new UserImportService({ transaction } as unknown as Database);
  return { service, queries, transaction };
}

describe('user imports', () => {
  it('stores a user, normalized email, country, and provenance together', async () => {
    const { service, queries, transaction } = fixture();
    expect(await service.importUsers(importUsersSchema.parse(user))).toEqual({ total: 1, created: 1, updated: 0, skipped: 0 });
    expect(transaction).toHaveBeenCalledOnce();
    const account = queries.find((q) => q.sql.includes('INSERT INTO source_accounts'))!;
    expect(account.values.slice(3, 8)).toEqual(['jane@example.com', 'Jane Doe', 'https://github.com/jane', 'Poland', 'Developer']);
    expect(JSON.parse(String(account.values[8]))).toEqual(user);
    const email = queries.find((q) => q.sql.includes('INSERT INTO email_addresses'))!;
    expect(email.values).toEqual(['jane@example.com', 'Jane@Example.com']);
    expect(email.sql).toContain("'unsure','imported'");
    expect(email.sql).toContain('ON CONFLICT (normalized_email) DO NOTHING RETURNING normalized_email');
    expect(queries.find((q) => q.sql.includes('INSERT INTO email_sources'))?.values.slice(2)).toEqual(['https://github.com/jane', 'Developer']);
  });

  it('restores a missing email on an existing imported account without creating a new person', async () => {
    const { service, queries } = fixture({ existing: true });
    expect(await service.importUsers(importUsersSchema.parse(user))).toEqual({ total: 1, created: 0, updated: 1, skipped: 0 });
    expect(queries.some((q) => q.sql.includes('INSERT INTO people'))).toBe(false);
    expect(queries.find((q) => q.sql.includes('UPDATE people'))?.values).toEqual(['person-id', 'Jane Doe']);
  });

  it('deduplicates email case and whitespace within and across uploads', async () => {
    const { service, queries } = fixture();
    expect(await service.importUsers(importUsersSchema.parse([user, { ...user, email: ' jane@example.COM ', name: 'New name' }]))).toEqual({ total: 2, created: 1, updated: 0, skipped: 1 });
    expect(await service.importUsers(importUsersSchema.parse(user))).toEqual({ total: 1, created: 0, updated: 0, skipped: 1 });
    expect(queries.filter((q) => q.sql.includes('INSERT INTO people'))).toHaveLength(1);
    expect(queries.some((q) => q.sql.includes('UPDATE people'))).toBe(false);
    expect(queries.filter((q) => q.sql.includes('INSERT INTO source_accounts'))).toHaveLength(1);
  });

  it('skips duplicate emails even when their fetch sources differ', async () => {
    const { service } = fixture();
    expect(await service.importUsers(importUsersSchema.parse([user, { ...user, fetch_source: 'another_directory' }]))).toEqual({ total: 2, created: 1, updated: 0, skipped: 1 });
  });

  it('skips an email from any existing contact before creating or changing user data', async () => {
    const { service, queries } = fixture({ existingEmail: true });
    expect(await service.importUsers(importUsersSchema.parse(user))).toEqual({ total: 1, created: 0, updated: 0, skipped: 1 });
    expect(queries.some((q) => q.sql.includes('INSERT INTO people') || q.sql.includes('UPDATE people') || q.sql.includes('INSERT INTO source_accounts') || q.sql.includes('INSERT INTO person_email_addresses') || q.sql.includes('INSERT INTO email_sources'))).toBe(false);
  });

  it('imports new emails in a batch containing existing emails', async () => {
    const { service } = fixture({ existingEmail: true });
    expect(await service.importUsers(importUsersSchema.parse([user, { ...user, email: 'new@example.com' }]))).toEqual({ total: 2, created: 1, updated: 0, skipped: 1 });
  });

  it('skips blocked records before writing contact data', async () => {
    const { service, queries } = fixture({ blocked: true });
    expect(await service.importUsers(importUsersSchema.parse(user))).toEqual({ total: 1, created: 0, updated: 0, skipped: 1 });
    expect(queries.some((q) => q.sql.includes('INSERT INTO people') || q.sql.includes('INSERT INTO email_addresses'))).toBe(false);
    const check = queries.find((q) => q.sql.includes('AS blocked'))!;
    expect(check.values.slice(0, 2)).toEqual(['jane@example.com', 'example.com']);
    expect(check.sql).toContain("status IN ('suppressed', 'deleted', 'invalid')");
    expect(check.sql).toContain('p.is_suppressed');
  });

  it('propagates persistence failures out of the transaction for rollback', async () => {
    const { service, queries } = fixture({ failEmail: true });
    await expect(service.importUsers(importUsersSchema.parse(user))).rejects.toThrow('Database unavailable');
    expect(queries.some((q) => q.sql.includes('INSERT INTO audit_log'))).toBe(false);
  });

  it('rejects the entire invalid batch before accessing storage and reports the row', () => {
    const service = { importUsers: vi.fn() };
    const controller = new UserImportController(service as unknown as UserImportService);
    expect(() => controller.importUsers([user, { ...user, email: 'invalid' }])).toThrow(BadRequestException);
    expect(() => controller.importUsers([user, { ...user, email: 'invalid' }])).toThrow('Row 2, email:');
    expect(service.importUsers).not.toHaveBeenCalled();
  });
});
