import type { Redis } from 'ioredis';
import { emptyJobCounters, type CollectionFilters } from '@email-fetch/shared';
import { describe, expect, it, vi } from 'vitest';
import { Collector } from './collector.js';
import type { Database } from './database.js';

describe('Collector checkpoints', () => {
  it('casts checkpoint values so PostgreSQL can resolve jsonb_build_object parameters', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const collector = new Collector({ query } as unknown as Database, {} as Redis);
    const checkpointCollector = collector as unknown as {
      jobId: string;
      counters: { candidatesDiscovered: number; usersInspected: number; skipped: number; suppressed: number };
      checkpoint(login: string): Promise<void>;
    };
    checkpointCollector.jobId = '52d2b647-7c9a-42b6-a1ec-77a9f4161968';
    checkpointCollector.counters = { candidatesDiscovered: 1, usersInspected: 1, skipped: 1, suppressed: 0 };

    await checkpointCollector.checkpoint('octocat');

    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]![0]).toContain("jsonb_build_object('lastLogin', $3::text, 'processed', $4::integer,");
    expect(query.mock.calls[0]![1]).toEqual([
      '52d2b647-7c9a-42b6-a1ec-77a9f4161968',
      JSON.stringify({ candidatesDiscovered: 1, usersInspected: 1, skipped: 1, suppressed: 0 }),
      'octocat',
      1,
      null
    ]);
  });

  it('finishes a cancelling job without resuming discovery', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: 'job-id', status: 'cancelling', filters_json: {}, counters_json: {} }] })
      .mockResolvedValue({ rows: [] });
    const collector = new Collector({ query } as unknown as Database, {} as Redis);

    await collector.run('job-id');

    expect(query.mock.calls.some(([statement]) => String(statement).includes("status = 'cancelled'"))).toBe(true);
    expect(query.mock.calls.some(([, values]) => Array.isArray(values) && values.includes('job_cancelled'))).toBe(true);
  });
});

function resumableCollector() {
  const filters: CollectionFilters = {
    keywords: ['match'], requirePublicEmail: false, discoveryPolicy: 'direct', minimumConfidence: 'unsure',
    excludePreviouslyProcessed: true, maxUsers: 100
  };
  const row = {
    id: 'job-id', status: 'queued', filters_json: filters, counters_json: emptyJobCounters(),
    checkpoint_json: {} as { lastLogin?: string; lastId?: number; counters?: ReturnType<typeof emptyJobCounters> }
  };
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    if (sql.startsWith('SELECT id, status')) return { rows: [row] };
    if (sql.includes('checkpoint_json = jsonb_build_object')) {
      row.counters_json = JSON.parse(values[1] as string);
      row.checkpoint_json = { lastLogin: values[2] as string, lastId: values[4] as number, counters: { ...row.counters_json } };
    } else if (sql.includes("status = 'failed'")) {
      row.status = 'failed';
      row.counters_json = JSON.parse(values[1] as string);
    } else if (sql.includes('SET status = $2')) {
      row.status = values[1] as string;
      if (sql.includes("phase = 'finished'")) row.counters_json = JSON.parse(values[2] as string);
    }
    return { rows: [] };
  });
  const collector = new Collector({ query } as unknown as Database, { eval: vi.fn().mockResolvedValue(1) } as unknown as Redis);
  const internals = collector as unknown as {
    github: { discover: ReturnType<typeof vi.fn>; profile: ReturnType<typeof vi.fn> };
    persistence: Record<string, ReturnType<typeof vi.fn>>;
  };
  const candidates = [1, 2, 3].map((id) => ({ id, login: `user${id}` }));
  internals.github.discover = vi.fn(async function* () { yield* candidates; });
  internals.github.profile = vi.fn(async (login: string) => {
    if (login === 'user3') throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    return { id: Number(login.slice(4)), login, type: 'User', bio: login === 'user1' ? 'match' : '' };
  });
  const persisted = new Set<string>();
  internals.persistence = {
    processedInJob: vi.fn(async (_jobId, id) => persisted.has(id)),
    existingAccount: vi.fn().mockResolvedValue(null),
    isSuppressed: vi.fn().mockResolvedValue(false),
    persist: vi.fn(async (_jobId, profile) => {
      persisted.add(String(profile.id));
      return { isNewUser: true, duplicateEmails: 0 };
    })
  };
  return { collector, row, query, candidates, ...internals };
}

describe('Collector continuation', () => {
  it('retries the interrupted profile without repeating saved or filtered-out profiles, even if the checkpoint login changed', async () => {
    const { collector, row, github, persistence, candidates } = resumableCollector();
    await expect(collector.run(row.id)).rejects.toThrow('timeout');
    expect(row.status).toBe('failed');
    expect(row.checkpoint_json).toMatchObject({ lastLogin: 'user2', lastId: 2 });
    expect(row.counters_json).toMatchObject({ candidatesDiscovered: 2, usersInspected: 2, newUsers: 1, skipped: 1, errors: 1 });

    row.status = 'queued';
    candidates[1]!.login = 'renamed-user2';
    github.profile.mockResolvedValue({ id: 3, login: 'user3', type: 'User', bio: 'match' });
    await collector.run(row.id);

    expect(github.profile.mock.calls.map(([login]) => login)).toEqual(['user1', 'user2', 'user3', 'user3']);
    expect(persistence.persist).toHaveBeenCalledTimes(2);
    expect(row.status).toBe('completed_with_errors');
    expect(row.counters_json).toMatchObject({ candidatesDiscovered: 3, usersInspected: 3, newUsers: 2, skipped: 1, errors: 1 });
  });

  it('continues legacy failed jobs using their saved login checkpoint', async () => {
    const { collector, row, github } = resumableCollector();
    row.checkpoint_json = { lastLogin: 'USER2' };
    row.counters_json = { ...emptyJobCounters(), candidatesDiscovered: 3, usersInspected: 2, newUsers: 1, skipped: 1, errors: 1 };
    github.profile.mockResolvedValue({ id: 3, login: 'user3', type: 'User', bio: 'match' });

    await collector.run(row.id);

    expect(github.profile.mock.calls.map(([login]) => login)).toEqual(['user3']);
    expect(row.counters_json).toMatchObject({ candidatesDiscovered: 3, usersInspected: 3, newUsers: 2, skipped: 1 });
  });

  it('keeps the job failed if the saved checkpoint disappeared from search results', async () => {
    const { collector, row, github } = resumableCollector();
    row.checkpoint_json = { lastLogin: 'missing-user', lastId: 999 };

    await expect(collector.run(row.id)).rejects.toThrow('Saved checkpoint was not found');

    expect(row.status).toBe('failed');
    expect(github.profile).not.toHaveBeenCalled();
  });

  it('does not restart completed jobs with errors', async () => {
    const { collector, row, github } = resumableCollector();
    row.status = 'completed_with_errors';
    await collector.run(row.id);
    expect(github.discover).not.toHaveBeenCalled();
  });
});
