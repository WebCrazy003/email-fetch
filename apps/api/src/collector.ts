import { emptyJobCounters, normalizeEmail, type CollectionFilters, type Confidence, type JobCounters } from '@email-fetch/shared';
import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { Database } from './database.js';
import { GitHubAdapter, GitHubRateLimitError, GitHubRequestError, isGitHubRelayEmail, type GitHubProfile } from './github-adapter.js';
import { type EmailObservation, PersistenceService } from './persistence.js';
import { guessEmails, inspectLinkedWebsite } from './website.js';
import { SourceAdapterRegistry } from './source-adapter.js';

type JobRow = { id: string; status: string; filters_json: CollectionFilters; counters_json: JobCounters };

const confidenceRank: Record<Confidence, number> = { unsure: 1, likely: 2, confirmed: 3 };

function sleep(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function matchesPostFilters(profile: GitHubProfile, activity: string | null, filters: CollectionFilters) {
  if (filters.keywords.length) {
    const haystack = `${profile.bio ?? ''} ${profile.company ?? ''}`.toLowerCase();
    if (!filters.keywords.some((keyword) => haystack.includes(keyword.toLowerCase()))) return false;
  }
  if (filters.activityFrom && (!activity || activity.slice(0, 10) < filters.activityFrom)) return false;
  if (filters.activityTo && (!activity || activity.slice(0, 10) > filters.activityTo)) return false;
  return true;
}

export class Collector {
  private readonly persistence: PersistenceService;
  private counters: JobCounters = emptyJobCounters();
  private jobId = '';
  private readonly github: GitHubAdapter;

  constructor(private readonly db: Database, private readonly redis: Redis) {
    this.persistence = new PersistenceService(db);
    const github = new GitHubAdapter(async () => {
      this.counters.requests += 1;
      await this.saveCounters();
    }, async (resetAt) => {
      const wait = Math.max(1_000, resetAt.getTime() - Date.now());
      await this.updateJob('rate_limited', 'waiting_for_github');
      await this.event('warning', 'github_rate_limited', 'GitHub rate limit reached', { resumeAt: resetAt.toISOString() });
      await sleep(wait);
      await this.updateJob('running', 'resuming');
    }, async () => {
      this.counters.retries += 1;
      await this.saveCounters();
    });
    const adapters = new SourceAdapterRegistry();
    adapters.register(github);
    this.github = adapters.get<GitHubAdapter>('github');
  }

  async run(jobId: string) {
    this.jobId = jobId;
    const job = await this.loadJob();
    this.counters = { ...emptyJobCounters(), ...(job.counters_json ?? {}) };
    if (['completed', 'cancelled'].includes(job.status)) return;
    await this.updateJob('running', 'discovering', { started_at: 'COALESCE(started_at, now())' });
    await this.event('info', 'job_started', 'Collection worker started');
    try {
      for await (const candidate of this.github.discover(job.filters_json)) {
        const state = await this.waitForRunnableState();
        if (state === 'cancelled') return;
        if (await this.persistence.processedInJob(jobId, String(candidate.id))) continue;
        this.counters.candidatesDiscovered += 1;
        const existing = await this.persistence.existingAccount(String(candidate.id));
        if (existing && job.filters_json.excludePreviouslyProcessed) {
          this.counters.skipped += 1;
          await this.persistence.recordSkipped(jobId, existing, 'skipped_previously_processed');
          await this.checkpoint(candidate.login);
          continue;
        }
        if (existing && Date.now() - new Date(existing.last_checked_at).getTime() < 7 * 86_400_000) {
          this.counters.skipped += 1;
          await this.persistence.recordSkipped(jobId, existing, 'skipped_fresh');
          await this.checkpoint(candidate.login);
          continue;
        }
        if (await this.persistence.isSuppressed(String(candidate.id), candidate.login)) {
          this.counters.suppressed += 1;
          await this.checkpoint(candidate.login);
          continue;
        }
        await this.consumeDaily('github_profiles', 25_000);
        await this.updateJob('running', 'inspecting_profiles');
        let profile: GitHubProfile;
        try {
          profile = await this.withRateLimit(() => this.github.profile(candidate.login));
        } catch (error) {
          if (!(error instanceof GitHubRequestError) || ![404, 410, 422].includes(error.status)) throw error;
          this.counters.errors += 1;
          await this.event('warning', 'profile_inspection_failed', 'GitHub profile could not be inspected', {
            login: candidate.login,
            status: error.status
          });
          await this.checkpoint(candidate.login);
          continue;
        }
        this.counters.usersInspected += 1;
        if (profile.type !== 'User') {
          this.counters.skipped += 1;
          await this.checkpoint(candidate.login);
          continue;
        }
        const activity = job.filters_json.activityFrom || job.filters_json.activityTo
          ? await this.withRateLimit(() => this.github.lastPublicActivity(candidate.login)) : null;
        if (!matchesPostFilters(profile, activity, job.filters_json)) {
          this.counters.skipped += 1;
          await this.checkpoint(candidate.login);
          continue;
        }
        const observations: EmailObservation[] = [];
        const directEmail = profile.email && !isGitHubRelayEmail(profile.email) ? profile.email : null;
        if (directEmail) {
          try {
            normalizeEmail(directEmail);
            observations.push({
              email: directEmail, discoveryType: 'source_profile', confidence: 'confirmed', score: 1,
              sourceMethod: 'github_api_profile', evidenceReference: `https://api.github.com/users/${encodeURIComponent(profile.login)}`,
              publiclyDeclared: true
            });
          } catch { this.counters.errors += 1; }
        }
        let websiteCheckedAt: string | undefined;
        if (!directEmail && profile.blog && job.filters_json.discoveryPolicy !== 'direct') {
          const lastWebsiteCheck = existing?.attributes_json?.websiteCheckedAt;
          const freshWebsite = typeof lastWebsiteCheck === 'string' && Date.now() - new Date(lastWebsiteCheck).getTime() < 30 * 86_400_000;
          if (!freshWebsite) {
            try {
              await this.consumeDaily('linked_websites', 5_000);
              await this.updateJob('running', 'enriching_websites');
              const found = await inspectLinkedWebsite(profile.blog, async () => {
                this.counters.requests += 1;
                await this.saveCounters();
              });
              websiteCheckedAt = new Date().toISOString();
              for (const item of found) observations.push({
                email: item.email, discoveryType: 'linked_website', confidence: 'confirmed', score: 0.95,
                sourceMethod: `linked_website:${new URL(item.evidenceUrl).pathname}`,
                evidenceReference: item.evidenceUrl, evidenceExcerpt: item.excerpt, publiclyDeclared: true
              });
            } catch (error) {
              this.counters.errors += 1;
              await this.event('warning', 'website_enrichment_failed', 'Linked website could not be inspected', { login: profile.login, reason: safeError(error) });
            }
          }
        }
        if (!observations.length && profile.blog && job.filters_json.discoveryPolicy === 'guesses') {
          for (const guess of guessEmails(profile.name, profile.login, profile.blog, [])) observations.push({
            email: guess.email, discoveryType: 'guessed', confidence: 'unsure', score: 0.25,
            sourceMethod: `guess:${guess.rule}`, evidenceReference: profile.html_url,
            derivationRule: guess.rule, publiclyDeclared: false
          });
        }
        const minRank = confidenceRank[job.filters_json.minimumConfidence]!;
        const eligible = observations.filter((item) => confidenceRank[item.confidence]! >= minRank);
        if (job.filters_json.requirePublicEmail && !eligible.some((item) => item.publiclyDeclared)) {
          this.counters.skipped += 1;
          await this.checkpoint(candidate.login);
          continue;
        }
        if (await this.persistence.isSuppressed(String(candidate.id), candidate.login)) {
          this.counters.suppressed += 1;
          await this.checkpoint(candidate.login);
          continue;
        }
        const result = await this.persistence.persist(jobId, profile, activity, eligible, websiteCheckedAt);
        this.counters[result.isNewUser ? 'newUsers' : 'updatedUsers'] += 1;
        this.counters.duplicateEmails += result.duplicateEmails;
        if (eligible.some((item) => item.publiclyDeclared)) this.counters.usersWithPublicEmail += 1;
        for (const item of eligible) {
          if (item.confidence === 'confirmed') this.counters.confirmedEmails += 1;
          if (item.confidence === 'likely') this.counters.likelyEmails += 1;
          if (item.confidence === 'unsure') this.counters.unsureEmails += 1;
          if (item.discoveryType === 'guessed') this.counters.guessedEmails += 1;
        }
        await this.checkpoint(candidate.login);
        if (this.counters.usersInspected >= job.filters_json.maxUsers) break;
      }
      const finalStatus = this.counters.errors > 0 ? 'completed_with_errors' : 'completed';
      await this.db.query(
        `UPDATE collection_jobs SET status = $2, phase = 'finished', counters_json = $3::jsonb,
          completed_at = now(), updated_at = now() WHERE id = $1`,
        [jobId, finalStatus, JSON.stringify(this.counters)]
      );
      await this.event('info', 'job_completed', `Collection ${finalStatus.replaceAll('_', ' ')}`, this.counters);
    } catch (error) {
      this.counters.errors += 1;
      await this.db.query(
        `UPDATE collection_jobs SET status = 'failed', phase = 'failed', counters_json = $2::jsonb,
          completed_at = now(), updated_at = now(), failure_code = $3, failure_message = $4 WHERE id = $1`,
        [jobId, JSON.stringify(this.counters), error instanceof GitHubRateLimitError ? 'github_rate_limit' : 'collector_error', safeError(error)]
      );
      await this.event('error', 'job_failed', 'Collection job failed', { reason: safeError(error) });
      throw error;
    }
  }

  private async loadJob(): Promise<JobRow> {
    const result = await this.db.query<JobRow>(`SELECT id, status, filters_json, counters_json FROM collection_jobs WHERE id = $1`, [this.jobId]);
    if (!result.rows[0]) throw new Error('Collection job not found');
    return result.rows[0];
  }

  private async waitForRunnableState(): Promise<'running' | 'cancelled'> {
    while (true) {
      const job = await this.loadJob();
      if (job.status === 'cancelling' || job.status === 'cancelled') {
        await this.db.query(`UPDATE collection_jobs SET status = 'cancelled', phase = 'cancelled', completed_at = now(), updated_at = now() WHERE id = $1`, [this.jobId]);
        await this.event('info', 'job_cancelled', 'Collection job cancelled');
        return 'cancelled';
      }
      if (job.status !== 'paused') return 'running';
      await sleep(1_000);
    }
  }

  private async withRateLimit<T>(operation: () => Promise<T>): Promise<T> {
    while (true) {
      try { return await operation(); }
      catch (error) {
        if (!(error instanceof GitHubRateLimitError)) throw error;
        const wait = Math.max(1_000, error.resetAt.getTime() - Date.now());
        await this.updateJob('rate_limited', 'waiting_for_github');
        await this.event('warning', 'github_rate_limited', 'GitHub rate limit reached', { resumeAt: error.resetAt.toISOString() });
        await sleep(wait);
        await this.updateJob('running', 'resuming');
      }
    }
  }

  private async consumeDaily(prefix: string, maximum: number) {
    const now = Date.now();
    const result = await this.redis.eval(
      `redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
       local count = redis.call('ZCARD', KEYS[1])
       if count >= tonumber(ARGV[2]) then return 0 end
       redis.call('ZADD', KEYS[1], ARGV[3], ARGV[4])
       redis.call('EXPIRE', KEYS[1], 172800)
       return count + 1`,
      1,
      `rolling_limit:${prefix}`,
      String(now - 86_400_000),
      String(maximum),
      String(now),
      `${this.jobId}:${randomUUID()}`
    );
    if (Number(result) === 0) throw new Error(`${prefix} rolling 24-hour limit reached`);
  }

  private async checkpoint(login: string) {
    await this.db.query(
      `UPDATE collection_jobs SET counters_json = $2::jsonb,
        checkpoint_json = jsonb_build_object('lastLogin', $3, 'processed', $4), updated_at = now() WHERE id = $1`,
      [this.jobId, JSON.stringify(this.counters), login, this.counters.usersInspected + this.counters.skipped + this.counters.suppressed]
    );
  }

  private saveCounters() {
    if (!this.jobId) return Promise.resolve();
    return this.db.query(`UPDATE collection_jobs SET counters_json = $2::jsonb, updated_at = now() WHERE id = $1`, [this.jobId, JSON.stringify(this.counters)]).then(() => undefined);
  }

  private async updateJob(status: string, phase: string, extra: Record<string, string> = {}) {
    const assignments = Object.entries(extra).map(([column, expression]) => `${column} = ${expression}`);
    await this.db.query(
      `UPDATE collection_jobs SET status = $2, phase = $3, updated_at = now()${assignments.length ? `, ${assignments.join(', ')}` : ''} WHERE id = $1`,
      [this.jobId, status, phase]
    );
  }

  private event(level: string, type: string, message: string, metadata: unknown = {}) {
    return this.db.query(
      `INSERT INTO job_events (job_id, level, event_type, message, metadata_json) VALUES ($1,$2,$3,$4,$5::jsonb)`,
      [this.jobId, level, type, message, JSON.stringify(metadata)]
    ).then(() => undefined);
  }
}

function safeError(error: unknown) {
  if (error instanceof Error) return error.message.slice(0, 500);
  return 'Unknown error';
}
