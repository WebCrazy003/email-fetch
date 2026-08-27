import type { CollectionFilters } from '@email-fetch/shared';
import { describe, expect, it, vi } from 'vitest';
import type { Database } from './database.js';
import { FiltersService } from './filters.js';
import type { JobsService } from './jobs.js';

const filters: CollectionFilters = {
  location: 'Poland', language: 'JavaScript', keywords: [], requirePublicEmail: false,
  discoveryPolicy: 'linked_site', minimumConfidence: 'unsure', excludePreviouslyProcessed: true, maxUsers: 1_000
};

describe('FiltersService', () => {
  it('saves a filter without starting a job', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: 'source-id' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'filter-id', name: 'Poland JavaScript', filters_json: filters }] });
    const createForFilter = vi.fn();
    const service = new FiltersService({ query } as unknown as Database, { createForFilter } as unknown as JobsService);

    const result = await service.create({ name: 'Poland JavaScript', source: 'github', filters });

    expect(result).toMatchObject({ id: 'filter-id' });
    expect(createForFilter).not.toHaveBeenCalled();
  });

  it('creates a job when a saved filter is run', async () => {
    const saved = { id: 'filter-id', name: 'Poland JavaScript', source_id: 'source-id', adapter_version: '1.0.0', filters_json: filters };
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [saved] })
      .mockResolvedValueOnce({ rows: [] });
    const createForFilter = vi.fn().mockResolvedValue({ id: 'job-id', status: 'queued' });
    const service = new FiltersService({ query } as unknown as Database, { createForFilter } as unknown as JobsService);

    await expect(service.run('filter-id')).resolves.toMatchObject({ id: 'job-id' });
    expect(createForFilter).toHaveBeenCalledWith(saved);
  });

  it('updates a saved filter without changing prior jobs or starting a new one', async () => {
    const updated = { id: 'filter-id', name: 'Poland TypeScript', source_id: 'source-id', source_key: 'github', adapter_version: '1.0.0', filters_json: { ...filters, language: 'TypeScript' } };
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: 'source-id' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'filter-id' }] })
      .mockResolvedValueOnce({ rows: [updated] });
    const createForFilter = vi.fn();
    const service = new FiltersService({ query } as unknown as Database, { createForFilter } as unknown as JobsService);

    await expect(service.update('filter-id', {
      name: 'Poland TypeScript', source: 'github', filters: { ...filters, language: 'TypeScript' }
    })).resolves.toMatchObject({ name: 'Poland TypeScript' });
    expect(createForFilter).not.toHaveBeenCalled();
    expect(query.mock.calls[1]![0]).not.toContain('collection_jobs');
  });
});
