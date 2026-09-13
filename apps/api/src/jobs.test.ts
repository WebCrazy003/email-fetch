import { describe, expect, it, vi } from 'vitest';
import type { Database } from './database.js';
import { JobsService } from './jobs.js';
import { QueueService } from './queue.service.js';

function serviceFixture(status = 'failed', claimed = true) {
  const current = {
    id: 'job-id', status, phase: 'failed', completed_at: '2026-09-13T11:47:37Z',
    failure_code: 'collector_error', failure_message: 'timeout',
    counters_json: { usersInspected: 199 }, checkpoint_json: { lastLogin: 'Stellarend' }
  };
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('RETURNING id')) return { rows: claimed ? [{ id: 'job-id' }] : [] };
    return { rows: [] };
  });
  const continueCollection = vi.fn().mockResolvedValue(undefined);
  const service = new JobsService({ query } as unknown as Database, { continueCollection } as unknown as QueueService);
  vi.spyOn(service, 'get').mockResolvedValue(current);
  return { service, current, query, continueCollection };
}

describe('Continue a collection job', () => {
  it('requeues the same job and clears failure details while preserving saved progress', async () => {
    const { service, query, continueCollection } = serviceFixture();
    await service.continue('job-id');
    expect(continueCollection).toHaveBeenCalledExactlyOnceWith('job-id');
    const update = query.mock.calls[0]![0];
    expect(update).toContain("WHERE id = $1 AND status = 'failed'");
    expect(update).toContain('failure_message = NULL');
    expect(update).toContain('completed_at = NULL');
    expect(update).not.toContain('counters_json');
    expect(update).not.toContain('checkpoint_json');
    expect(query.mock.calls.some(([sql]) => sql.includes('INSERT INTO job_events'))).toBe(true);
  });

  it.each(['running', 'queued', 'paused', 'completed', 'completed_with_errors', 'cancelled'])('does not requeue a %s job', async (status) => {
    const { service, current, query, continueCollection } = serviceFixture(status);
    await expect(service.continue('job-id')).resolves.toBe(current);
    expect(continueCollection).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('does not enqueue twice when another request already claimed the job', async () => {
    const { service, continueCollection } = serviceFixture('failed', false);
    await service.continue('job-id');
    expect(continueCollection).not.toHaveBeenCalled();
  });

  it('restores the failed state if queue submission fails so Continue stays available', async () => {
    const { service, query, continueCollection } = serviceFixture();
    continueCollection.mockRejectedValue(new Error('Redis unavailable'));
    await expect(service.continue('job-id')).rejects.toThrow('Redis unavailable');
    expect(query.mock.calls[1]![0]).toContain("SET status = 'failed'");
    expect(query.mock.calls[1]![0]).toContain("WHERE id = $1 AND status = 'queued'");
  });
});

describe('Collection queue continuation', () => {
  function queueFixture(job: unknown) {
    // Avoid starting real Redis connections in these queue adapter tests.
    const queue = Object.create(QueueService.prototype) as QueueService;
    Object.defineProperty(queue, 'collection', { value: { getJob: vi.fn().mockResolvedValue(job) } });
    const enqueue = vi.spyOn(queue, 'enqueue').mockResolvedValue(undefined as never);
    return { queue, enqueue };
  }

  it('retries a retained failed queue entry rather than adding a duplicate ID', async () => {
    const retry = vi.fn().mockResolvedValue(undefined);
    const { queue, enqueue } = queueFixture({ getState: vi.fn().mockResolvedValue('failed'), retry });
    await queue.continueCollection('job-id');
    expect(retry).toHaveBeenCalledExactlyOnceWith('failed');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('recreates a queue entry that was removed by retention', async () => {
    const { queue, enqueue } = queueFixture(undefined);
    await queue.continueCollection('job-id');
    expect(enqueue).toHaveBeenCalledExactlyOnceWith('job-id');
  });

  it('refuses to retry an entry while the worker is still active', async () => {
    const retry = vi.fn();
    const { queue, enqueue } = queueFixture({ getState: vi.fn().mockResolvedValue('active'), retry });
    await expect(queue.continueCollection('job-id')).rejects.toThrow('still finishing');
    expect(retry).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });
});
