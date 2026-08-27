import type { CollectionFilters } from '@email-fetch/shared';
import type { SourceAdapter } from './source-adapter.js';

export interface GitHubSearchUser {
  login: string;
  id: number;
  url: string;
  html_url: string;
}

export interface GitHubProfile {
  login: string;
  id: number;
  name: string | null;
  avatar_url: string | null;
  html_url: string;
  bio: string | null;
  company: string | null;
  location: string | null;
  blog: string | null;
  email: string | null;
  twitter_username: string | null;
  public_repos: number;
  public_gists: number;
  followers: number;
  following: number;
  hireable: boolean | null;
  type: string;
  created_at: string;
  updated_at: string;
}

interface SearchResponse {
  total_count: number;
  incomplete_results: boolean;
  items: GitHubSearchUser[];
}

interface GitHubEvent { created_at: string }

export class GitHubRateLimitError extends Error {
  constructor(readonly resetAt: Date, message = 'GitHub rate limit reached') { super(message); }
}

export class GitHubRequestError extends Error {
  constructor(readonly status: number) { super(`GitHub request failed (${status})`); }
}

function quote(value: string): string {
  return `"${value.replaceAll('"', '\\"')}"`;
}

function dateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function midpoint(from: Date, to: Date): Date {
  return new Date(Math.floor((from.getTime() + to.getTime()) / 2));
}

export function buildGitHubQuery(filters: CollectionFilters, createdFrom?: string, createdTo?: string): string {
  const parts = ['type:user'];
  if (filters.location) parts.push(`location:${quote(filters.location)}`);
  if (filters.language) parts.push(`language:${quote(filters.language)}`);
  if (filters.followersMin !== undefined || filters.followersMax !== undefined) {
    parts.push(`followers:${range(filters.followersMin, filters.followersMax)}`);
  }
  if (filters.repositoriesMin !== undefined || filters.repositoriesMax !== undefined) {
    parts.push(`repos:${range(filters.repositoriesMin, filters.repositoriesMax)}`);
  }
  const from = createdFrom ?? filters.createdFrom;
  const to = createdTo ?? filters.createdTo;
  if (from || to) parts.push(`created:${dateRange(from, to)}`);
  return parts.join(' ');
}

export function isGitHubRelayEmail(email: string): boolean {
  const domain = email.trim().toLowerCase().split('@').at(-1);
  return domain === 'users.noreply.github.com' || domain === 'noreply.github.com';
}

function range(min?: number, max?: number): string {
  if (min !== undefined && max !== undefined) return `${min}..${max}`;
  if (min !== undefined) return `>=${min}`;
  return `<=${max}`;
}

function dateRange(from?: string, to?: string): string {
  if (from && to) return `${from}..${to}`;
  if (from) return `>=${from}`;
  return `<=${to}`;
}

export class GitHubAdapter implements SourceAdapter<GitHubSearchUser, GitHubProfile> {
  readonly sourceKey = 'github';
  readonly adapterVersion = '1.0.0';
  private readonly token = process.env.GITHUB_TOKEN;

  constructor(
    private readonly onRequest: () => Promise<void>,
    private readonly onRateLimit?: (resetAt: Date) => Promise<void>,
    private readonly onRetry?: () => Promise<void>
  ) {}

  async *discover(filters: CollectionFilters): AsyncGenerator<GitHubSearchUser> {
    const seen = new Set<number>();
    const start = new Date(`${filters.createdFrom ?? '2008-01-01'}T00:00:00.000Z`);
    const end = new Date(`${filters.createdTo ?? dateOnly(new Date())}T23:59:59.999Z`);
    for await (const user of this.segment(filters, start, end)) {
      if (!seen.has(user.id)) {
        seen.add(user.id);
        yield user;
      }
      if (seen.size >= filters.maxUsers) return;
    }
  }

  private async *segment(filters: CollectionFilters, from: Date, to: Date): AsyncGenerator<GitHubSearchUser> {
    const query = buildGitHubQuery(filters, dateOnly(from), dateOnly(to));
    const first = await this.search(query, 1);
    const canSplit = dateOnly(from) !== dateOnly(to);
    if ((first.total_count > 1_000 || first.incomplete_results) && canSplit) {
      const middle = midpoint(from, to);
      const leftEnd = new Date(middle);
      const rightStart = new Date(middle.getTime() + 86_400_000);
      yield* this.segment(filters, from, leftEnd);
      if (rightStart <= to) yield* this.segment(filters, rightStart, to);
      return;
    }
    const available = Math.min(first.total_count, 1_000);
    yield* first.items;
    const pages = Math.ceil(available / 100);
    for (let page = 2; page <= pages; page += 1) {
      const response = await this.search(query, page);
      yield* response.items;
    }
  }

  private search(query: string, page: number) {
    const params = new URLSearchParams({ q: query, per_page: '100', page: String(page), sort: 'joined', order: 'asc' });
    return this.request<SearchResponse>(`/search/users?${params}`);
  }

  profile(login: string) {
    return this.request<GitHubProfile>(`/users/${encodeURIComponent(login)}`);
  }

  async lastPublicActivity(login: string): Promise<string | null> {
    const events = await this.request<GitHubEvent[]>(`/users/${encodeURIComponent(login)}/events/public?per_page=1`);
    return events[0]?.created_at ?? null;
  }

  private async request<T>(path: string, attempt = 0): Promise<T> {
    await this.onRequest();
    const response = await fetch(`https://api.github.com${path}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'email-fetch-local/0.1',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {})
      },
      signal: AbortSignal.timeout(20_000)
    });
    if (response.status === 403 || response.status === 429) {
      const retryAfter = Number(response.headers.get('retry-after') ?? 0);
      const resetSeconds = Number(response.headers.get('x-ratelimit-reset') ?? 0);
      const resetAt = retryAfter > 0 ? new Date(Date.now() + retryAfter * 1_000) : new Date(resetSeconds * 1_000 || Date.now() + 60_000);
      if (this.onRateLimit) {
        await this.onRetry?.();
        await this.onRateLimit(resetAt);
        return this.request<T>(path, attempt);
      }
      throw new GitHubRateLimitError(resetAt);
    }
    if (response.status >= 500 && attempt < 3) {
      await this.onRetry?.();
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt + Math.random() * 250));
      return this.request<T>(path, attempt + 1);
    }
    if (!response.ok) throw new GitHubRequestError(response.status);
    return response.json() as Promise<T>;
  }
}
