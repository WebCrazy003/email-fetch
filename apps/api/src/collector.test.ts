import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import { Collector } from './collector.js';
import type { Database } from './database.js';

describe('Collector checkpoints', () => {
  it('casts checkpoint values so PostgreSQL can resolve jsonb_build_object parameters', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const collector = new Collector({ query } as unknown as Database, {} as Redis);
    const checkpointCollector = collector as unknown as {
      jobId: string;
      counters: { usersInspected: number; skipped: number; suppressed: number };
      checkpoint(login: string): Promise<void>;
    };
    checkpointCollector.jobId = '52d2b647-7c9a-42b6-a1ec-77a9f4161968';
    checkpointCollector.counters = { usersInspected: 1, skipped: 1, suppressed: 0 };

    await checkpointCollector.checkpoint('octocat');

    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]![0]).toContain("jsonb_build_object('lastLogin', $3::text, 'processed', $4::integer)");
    expect(query.mock.calls[0]![1]).toEqual([
      '52d2b647-7c9a-42b6-a1ec-77a9f4161968',
      JSON.stringify({ usersInspected: 1, skipped: 1, suppressed: 0 }),
      'octocat',
      2
    ]);
  });
});
