import { Controller, Get } from '@nestjs/common';
import { Database } from './database.js';

@Controller()
export class SystemController {
  constructor(private readonly db: Database) {}

  @Get('health')
  async health() {
    await this.db.query('SELECT 1');
    return { status: 'ok', localOnly: true, timestamp: new Date().toISOString() };
  }

  @Get('settings')
  settings() {
    return {
      localOnly: true,
      authentication: false,
      exports: false,
      automaticRetention: false,
      githubConfigured: Boolean(process.env.GITHUB_TOKEN),
      limits: {
        usersPerJob: 10_000,
        profilesPerDay: 25_000,
        websitesPerDay: 5_000,
        pagesPerWebsite: 5,
        guessesPerPerson: 3,
        storedAccountsReviewAt: 1_000_000
      },
      freshnessDays: { githubProfile: 7, linkedWebsite: 30 }
    };
  }

  @Get('dashboard')
  async dashboard() {
    const result = await this.db.query<{
      active_jobs: string; completed_jobs: string; users: string; active_emails: string; recent_errors: string;
    }>(`SELECT
      (SELECT count(*) FROM collection_jobs WHERE status IN ('queued','running','paused','rate_limited'))::text AS active_jobs,
      (SELECT count(*) FROM collection_jobs WHERE status IN ('completed','completed_with_errors'))::text AS completed_jobs,
      (SELECT count(*) FROM people WHERE lifecycle_status <> 'deleted')::text AS users,
      (SELECT count(*) FROM email_addresses WHERE status = 'active')::text AS active_emails,
      (SELECT count(*) FROM job_events WHERE level = 'error' AND created_at > now() - interval '24 hours')::text AS recent_errors`);
    return Object.fromEntries(Object.entries(result.rows[0]!).map(([key, value]) => [key, Number(value)]));
  }
}
