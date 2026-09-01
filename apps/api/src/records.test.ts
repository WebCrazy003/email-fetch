import { emailQuerySchema } from '@email-fetch/shared';
import { describe, expect, it } from 'vitest';
import type { Database } from './database.js';
import { RecordsService } from './records.js';

describe('email record filters', () => {
  it('matches country text against linked account locations', async () => {
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const db = {
      query: async (text: string, values: unknown[] = []) => {
        queries.push({ text, values });
        return { rows: text.includes('count(*)::text') ? [{ count: '0' }] : [] };
      }
    } as unknown as Database;
    const records = new RecordsService(db);

    await records.listEmails(emailQuerySchema.parse({ country: 'Poland' }));

    expect(queries[0]?.text).toContain('JOIN source_accounts sa ON sa.person_id = pe.person_id');
    expect(queries[0]?.text).toContain('sa.location ILIKE $1');
    expect(queries[0]?.values).toEqual(['%Poland%', 25, 0]);
    expect(queries[1]?.values).toEqual(['%Poland%']);
  });

  it('finds emails without any linked account location', async () => {
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const db = {
      query: async (text: string, values: unknown[] = []) => {
        queries.push({ text, values });
        return { rows: text.includes('count(*)::text') ? [{ count: '0' }] : [] };
      }
    } as unknown as Database;
    const records = new RecordsService(db);

    await records.listEmails(emailQuerySchema.parse({ country: 'not_specified' }));

    expect(queries[0]?.text).toContain('NOT EXISTS');
    expect(queries[0]?.text).toContain("NULLIF(BTRIM(sa.location), '') IS NOT NULL");
    expect(queries[0]?.values).toEqual([25, 0]);
    expect(queries[1]?.values).toEqual([]);
  });
});
