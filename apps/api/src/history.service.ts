import { createHash } from 'node:crypto';
import { Injectable, NotFoundException } from '@nestjs/common';
import { Database } from './database.js';

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

@Injectable()
export class HistoryService {
  constructor(private readonly db: Database) {}

  async record(context: 'new_collection' | 'collected_users' | 'emails', filters: unknown, sort: unknown, resultCount?: number, jobId?: string) {
    const canonical = stable({ filters, sort });
    const hash = createHash('sha256').update(canonical).digest('hex');
    const history = await this.db.query<{ id: string }>(
      `INSERT INTO search_history (context, filters_json, sort_json, filter_hash)
       VALUES ($1, $2::jsonb, $3::jsonb, $4)
       ON CONFLICT (context, filter_hash) DO UPDATE SET
         last_executed_at = now(), execution_count = search_history.execution_count + 1, deleted_at = NULL
       RETURNING id`,
      [context, JSON.stringify(filters), JSON.stringify(sort ?? {}), hash]
    );
    await this.db.query(
      `INSERT INTO search_executions (search_history_id, collection_job_id, result_count)
       VALUES ($1, $2, $3)`,
      [history.rows[0]!.id, jobId ?? null, resultCount ?? null]
    );
    return history.rows[0]!.id;
  }

  async list(context?: string) {
    const values: unknown[] = [];
    const condition = context ? `AND h.context = $${values.push(context)}` : '';
    const result = await this.db.query(
      `SELECT h.*, e.result_count AS last_result_count, e.collection_job_id AS last_job_id
       FROM search_history h
       LEFT JOIN LATERAL (
         SELECT result_count, collection_job_id FROM search_executions
         WHERE search_history_id = h.id ORDER BY executed_at DESC LIMIT 1
       ) e ON true
       WHERE h.deleted_at IS NULL ${condition}
       ORDER BY h.last_executed_at DESC LIMIT 200`,
      values
    );
    return result.rows;
  }

  async get(id: string) {
    const result = await this.db.query(`SELECT * FROM search_history WHERE id = $1 AND deleted_at IS NULL`, [id]);
    if (!result.rows[0]) throw new NotFoundException('Search history entry not found');
    return result.rows[0];
  }

  async rename(id: string, label: string | null) {
    const result = await this.db.query(`UPDATE search_history SET label = $2 WHERE id = $1 AND deleted_at IS NULL RETURNING *`, [id, label]);
    if (!result.rows[0]) throw new NotFoundException('Search history entry not found');
    return result.rows[0];
  }

  async remove(id: string) {
    const result = await this.db.query(`UPDATE search_history SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING id`, [id]);
    if (!result.rows[0]) throw new NotFoundException('Search history entry not found');
  }

  async clear() {
    const result = await this.db.query(`UPDATE search_history SET deleted_at = now() WHERE deleted_at IS NULL RETURNING id`);
    return result.rowCount ?? 0;
  }
}
