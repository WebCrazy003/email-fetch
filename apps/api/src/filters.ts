import { Body, ConflictException, Controller, Get, Injectable, NotFoundException, Param, Post } from '@nestjs/common';
import { createFilterSchema, type CollectionFilters, type CreateFilterInput } from '@email-fetch/shared';
import { Database } from './database.js';
import { parseWith } from './http.js';
import { JobsService } from './jobs.js';

type FilterRow = {
  id: string;
  name: string;
  source_id: string;
  adapter_version: string;
  filters_json: CollectionFilters;
};

const activeStatuses = ['queued', 'running', 'paused', 'rate_limited', 'cancelling'];

@Injectable()
export class FiltersService {
  constructor(private readonly db: Database, private readonly jobs: JobsService) {}

  async create(input: CreateFilterInput) {
    const source = await this.db.query<{ id: string }>(
      `SELECT id FROM sources WHERE source_key = $1 AND enabled = true`,
      [input.source]
    );
    if (!source.rows[0]) throw new NotFoundException('GitHub source is not enabled');
    const result = await this.db.query(
      `INSERT INTO saved_filters (name, source_id, filters_json)
       VALUES ($1, $2, $3::jsonb)
       RETURNING id, name, source_id, filters_json, created_at, updated_at`,
      [input.name, source.rows[0].id, JSON.stringify(input.filters)]
    );
    return result.rows[0];
  }

  async list() {
    const result = await this.db.query(
      `SELECT f.id, f.name, f.source_id, f.filters_json, f.created_at, f.updated_at, s.source_key,
        COALESCE(stats.run_count, 0)::int AS run_count,
        latest.id AS latest_job_id, latest.status AS latest_job_status, latest.phase AS latest_job_phase,
        latest.counters_json AS latest_counters_json, latest.created_at AS latest_job_created_at,
        latest.completed_at AS latest_job_completed_at, latest.failure_message AS latest_failure_message
       FROM saved_filters f
       JOIN sources s ON s.id = f.source_id
       LEFT JOIN LATERAL (
         SELECT count(*)::int AS run_count FROM collection_jobs j WHERE j.saved_filter_id = f.id
       ) stats ON true
       LEFT JOIN LATERAL (
         SELECT j.id, j.status, j.phase, j.counters_json, j.created_at, j.completed_at, j.failure_message
         FROM collection_jobs j WHERE j.saved_filter_id = f.id
         ORDER BY (j.status IN ('queued','running','paused','rate_limited','cancelling')) DESC, j.created_at DESC
         LIMIT 1
       ) latest ON true
       ORDER BY f.updated_at DESC, f.created_at DESC`
    );
    return result.rows;
  }

  async get(id: string): Promise<FilterRow> {
    const result = await this.db.query<FilterRow>(
      `SELECT f.id, f.name, f.source_id, f.filters_json, s.adapter_version
       FROM saved_filters f JOIN sources s ON s.id = f.source_id
       WHERE f.id = $1`,
      [id]
    );
    if (!result.rows[0]) throw new NotFoundException('Filter not found');
    return result.rows[0];
  }

  async run(id: string) {
    const filter = await this.get(id);
    const active = await this.db.query<{ id: string }>(
      `SELECT id FROM collection_jobs WHERE saved_filter_id = $1 AND status = ANY($2::text[]) LIMIT 1`,
      [id, activeStatuses]
    );
    if (active.rows[0]) throw new ConflictException('This filter already has a running job');
    return this.jobs.createForFilter(filter);
  }
}

@Controller('filters')
export class FiltersController {
  constructor(private readonly filters: FiltersService) {}

  @Get()
  list() { return this.filters.list(); }

  @Post()
  create(@Body() body: unknown) { return this.filters.create(parseWith(createFilterSchema, body)); }

  @Post(':id/run')
  run(@Param('id') id: string) { return this.filters.run(id); }
}
