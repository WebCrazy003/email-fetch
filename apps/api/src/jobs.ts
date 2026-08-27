import { Controller, Get, Injectable, MessageEvent, NotFoundException, Param, Post, Query, Sse } from '@nestjs/common';
import { emptyJobCounters, type CollectionFilters } from '@email-fetch/shared';
import { concatMap, from, interval, map, Observable, startWith } from 'rxjs';
import { Database } from './database.js';
import { QueueService } from './queue.service.js';
import { buildGitHubQuery } from './github-adapter.js';

@Injectable()
export class JobsService {
  constructor(
    private readonly db: Database,
    private readonly queue: QueueService
  ) {}

  async createForFilter(filter: { id: string; name: string; source_id: string; adapter_version: string; filters_json: CollectionFilters }) {
    const row = await this.db.query<{ id: string }>(
      `INSERT INTO collection_jobs
        (name, source_id, source_adapter_version, saved_filter_id, status, filters_json, adapter_query_json, counters_json)
       VALUES ($1, $2, $3, $4, 'queued', $5::jsonb, $6::jsonb, $7::jsonb)
       RETURNING id`,
      [filter.name, filter.source_id, filter.adapter_version, filter.id, JSON.stringify(filter.filters_json),
        JSON.stringify({ query: buildGitHubQuery(filter.filters_json), partitionStrategy: 'created_range' }), JSON.stringify(emptyJobCounters())]
    );
    const jobId = row.rows[0]!.id;
    await this.event(jobId, 'info', 'job_created', 'Job created from saved filter', { filterId: filter.id, filters: filter.filters_json });
    await this.queue.enqueue(jobId);
    return this.get(jobId);
  }

  async list(page = 1, pageSize = 25) {
    const safePage = Math.max(1, page);
    const safeSize = Math.min(100, Math.max(1, pageSize));
    const offset = (safePage - 1) * safeSize;
    const [rows, count] = await Promise.all([
      this.db.query(
        `SELECT j.*, s.source_key FROM collection_jobs j JOIN sources s ON s.id = j.source_id
         ORDER BY j.created_at DESC LIMIT $1 OFFSET $2`,
        [safeSize, offset]
      ),
      this.db.query<{ count: string }>(`SELECT count(*)::text AS count FROM collection_jobs`)
    ]);
    return { items: rows.rows, page: safePage, pageSize: safeSize, total: Number(count.rows[0]!.count) };
  }

  async get(id: string) {
    const result = await this.db.query(
      `SELECT j.*, s.source_key,
        (SELECT json_agg(e ORDER BY e.created_at DESC) FROM (
          SELECT id, level, event_type, message, metadata_json, created_at
          FROM job_events WHERE job_id = j.id ORDER BY created_at DESC LIMIT 50
        ) e) AS recent_events
       FROM collection_jobs j JOIN sources s ON s.id = j.source_id WHERE j.id = $1`,
      [id]
    );
    if (!result.rows[0]) throw new NotFoundException('Job not found');
    return result.rows[0];
  }

  async setState(id: string, action: 'pause' | 'resume' | 'cancel') {
    const current = await this.get(id) as { status: string };
    let next: string;
    if (action === 'pause' && ['queued', 'running', 'rate_limited'].includes(current.status)) next = 'paused';
    else if (action === 'resume' && ['paused', 'rate_limited'].includes(current.status)) next = 'running';
    else if (action === 'cancel' && ['queued', 'running', 'paused', 'rate_limited'].includes(current.status)) next = 'cancelling';
    else return current;
    await this.db.query(`UPDATE collection_jobs SET status = $2, updated_at = now() WHERE id = $1`, [id, next]);
    await this.event(id, 'info', `job_${action}`, `Job ${action} requested`);
    return this.get(id);
  }

  async event(jobId: string, level: string, type: string, message: string, metadata: unknown = {}) {
    await this.db.query(
      `INSERT INTO job_events (job_id, level, event_type, message, metadata_json) VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [jobId, level, type, message, JSON.stringify(metadata)]
    );
  }
}

@Controller('jobs')
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

  @Get()
  list(@Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return this.jobs.list(Number(page ?? 1), Number(pageSize ?? 25));
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.jobs.get(id);
  }

  @Post(':id/pause')
  pause(@Param('id') id: string) {
    return this.jobs.setState(id, 'pause');
  }

  @Post(':id/resume')
  resume(@Param('id') id: string) {
    return this.jobs.setState(id, 'resume');
  }

  @Post(':id/cancel')
  cancel(@Param('id') id: string) {
    return this.jobs.setState(id, 'cancel');
  }

  @Sse(':id/stream')
  stream(@Param('id') id: string): Observable<MessageEvent> {
    return interval(1_000).pipe(
      startWith(0),
      concatMap(() => from(this.jobs.get(id))),
      map((data) => ({ data, type: 'job' }))
    );
  }
}
