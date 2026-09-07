import { emailQuerySchema } from '@email-fetch/shared';
import { describe, expect, it } from 'vitest';
import type { Database } from './database.js';
import { RecordsService } from './records.js';

function fixture() {
  const queries: Array<{ text: string; values: unknown[] }> = [];
  const db = {
    query: async (text: string, values: unknown[] = []) => {
      queries.push({ text, values });
      if (text.includes('AS value FROM source_accounts')) return { rows: [
        { value: 'Warsaw, Poland' }, { value: 'poland' }, { value: 'USA' },
        { value: 'London' }, { value: 'Unknown' }, { value: null }
      ] };
      return { rows: text.includes('count(*)::text') ? [{ count: '0' }] : [] };
    }
  } as unknown as Database;
  return { queries, records: new RecordsService(db) };
}

describe('email record countries', () => {
  it('returns sorted unique countries found in the full user list', async () => {
    const { queries, records } = fixture();
    expect(await records.listCountries()).toEqual(['Poland', 'United States']);
    expect(queries[0]?.text).toContain("sa.attributes_json->>'country'");
    expect(queries[0]?.text).toContain("p.lifecycle_status <> 'deleted'");
    expect(queries[0]?.text).not.toContain('LIMIT');
  });

  it('uses the same resolved countries for filtering, table display, and pagination', async () => {
    const { queries, records } = fixture();
    await records.listEmails(emailQuerySchema.parse({ country: 'Poland' }));
    const mapping = JSON.stringify([
      { value: 'Warsaw, Poland', country: 'Poland' }, { value: 'poland', country: 'Poland' }, { value: 'USA', country: 'United States' }
    ]);
    expect(queries[1]?.text).toContain('lower(ac.country) = lower($2)');
    expect(queries[1]?.text).toContain('AS countries');
    expect(queries[1]?.values).toEqual([mapping, 'Poland', 25, 0]);
    expect(queries[2]?.values).toEqual([mapping, 'Poland']);
  });

  it('finds emails without a recognized country, including nonempty unknown locations', async () => {
    const { queries, records } = fixture();
    await records.listEmails(emailQuerySchema.parse({ country: 'not_specified' }));
    expect(queries[1]?.text).toContain('NOT EXISTS');
    expect(queries[1]?.text).toContain('JOIN account_countries ac ON ac.person_id = pe.person_id');
    const values = JSON.parse(String(queries[1]?.values[0]));
    expect(values.some((row: { value: string }) => ['London', 'Unknown'].includes(row.value))).toBe(false);
    expect(queries[1]?.values.slice(1)).toEqual([25, 0]);
    expect(queries[2]?.values).toEqual([queries[1]?.values[0]]);
  });
});
