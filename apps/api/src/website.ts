import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import * as cheerio from 'cheerio';
import * as robotsParserModule from 'robots-parser';
import { normalizeEmail } from '@email-fetch/shared';

const EMAIL_PATTERN = /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+/gi;
const PREFERRED_PATH = /(contact|about|team|people)/i;
const USER_AGENT = 'email-fetch-local/0.1';

export interface WebsiteEmail {
  email: string;
  evidenceUrl: string;
  excerpt: string;
}

interface RobotRules { isAllowed(url: string, userAgent?: string): boolean | undefined }
const robotsParser = ((robotsParserModule as unknown as { default?: unknown }).default ?? robotsParserModule) as unknown as (url: string, text: string) => RobotRules;

function isPrivateIp(address: string): boolean {
  if (address === '::1' || address.startsWith('fc') || address.startsWith('fd') || address.startsWith('fe80:')) return true;
  if (isIP(address) !== 4) return false;
  const parts = address.split('.').map(Number);
  return parts[0] === 10 || parts[0] === 127 || (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) || (parts[0] === 192 && parts[1] === 168) || parts[0] === 0;
}

async function assertPublicHost(hostname: string) {
  if (hostname === 'localhost' || hostname.endsWith('.local')) throw new Error('Private website targets are blocked');
  const addresses = await lookup(hostname, { all: true });
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateIp(address))) throw new Error('Private website targets are blocked');
}

async function safeFetch(url: URL, onRequest: () => Promise<void>, redirects = 0): Promise<Response> {
  await assertPublicHost(url.hostname);
  await onRequest();
  const response = await fetch(url, {
    redirect: 'manual',
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,text/plain;q=0.9' },
    signal: AbortSignal.timeout(10_000)
  });
  if (response.status >= 300 && response.status < 400) {
    if (redirects >= 3) throw new Error('Website redirect limit reached');
    const location = response.headers.get('location');
    if (!location) throw new Error('Invalid website redirect');
    const next = new URL(location, url);
    if (next.hostname !== url.hostname) throw new Error('Cross-domain redirects are blocked');
    return safeFetch(next, onRequest, redirects + 1);
  }
  if (!response.ok) throw new Error(`Website request failed (${response.status})`);
  const length = Number(response.headers.get('content-length') ?? 0);
  if (length > 2_000_000) throw new Error('Website response is too large');
  return response;
}

export async function inspectLinkedWebsite(rawUrl: string, onRequest: () => Promise<void> = async () => {}): Promise<WebsiteEmail[]> {
  const root = new URL(rawUrl.match(/^https?:\/\//i) ? rawUrl : `https://${rawUrl}`);
  if (!['http:', 'https:'].includes(root.protocol)) throw new Error('Unsupported website protocol');
  await assertPublicHost(root.hostname);
  let robots = robotsParser(new URL('/robots.txt', root).toString(), '');
  try {
    const response = await safeFetch(new URL('/robots.txt', root), onRequest);
    robots = robotsParser(response.url, (await response.text()).slice(0, 500_000));
  } catch {
    // An unavailable robots file is treated as no additional restriction.
  }

  const queue = [new URL('/', root), root];
  const visited = new Set<string>();
  const results = new Map<string, WebsiteEmail>();
  while (queue.length && visited.size < 5) {
    const url = queue.shift()!;
    url.hash = '';
    if (url.hostname !== root.hostname || visited.has(url.toString()) || !robots.isAllowed(url.toString(), USER_AGENT)) continue;
    visited.add(url.toString());
    const response = await safeFetch(url, onRequest);
    const type = response.headers.get('content-type') ?? '';
    if (!type.includes('text/html') && !type.includes('text/plain')) continue;
    const text = (await response.text()).slice(0, 2_000_000);
    for (const match of text.matchAll(EMAIL_PATTERN)) {
      try {
        const normalized = normalizeEmail(match[0]);
        const start = Math.max(0, (match.index ?? 0) - 60);
        const excerpt = text.slice(start, start + match[0].length + 120).replace(/\s+/g, ' ').slice(0, 240);
        results.set(normalized, { email: match[0], evidenceUrl: url.toString(), excerpt });
      } catch { /* ignore malformed candidates */ }
    }
    if (type.includes('text/html')) {
      const $ = cheerio.load(text);
      const links = $('a[href]').toArray()
        .map((element) => $(element).attr('href'))
        .filter((href): href is string => Boolean(href));
      for (const href of links) {
        try {
          const next = new URL(href, url);
          if (next.hostname === root.hostname && PREFERRED_PATH.test(next.pathname) && !visited.has(next.toString())) queue.push(next);
        } catch { /* ignore invalid links */ }
      }
    }
  }
  return [...results.values()];
}

export function guessEmails(name: string | null, login: string, websiteUrl: string, existing: string[]): Array<{ email: string; rule: string }> {
  const domain = new URL(websiteUrl.match(/^https?:\/\//i) ? websiteUrl : `https://${websiteUrl}`).hostname.replace(/^www\./, '').toLowerCase();
  const known = new Set(existing.map((email) => normalizeEmail(email)));
  const candidates: Array<{ local: string; rule: string }> = [{ local: login, rule: 'github_login@linked_domain' }];
  const names = (name ?? '').normalize('NFKD').replace(/[^a-zA-Z\s'-]/g, '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (names.length >= 2) {
    const first = names[0]!;
    const last = names.at(-1)!;
    candidates.push({ local: `${first}.${last}`, rule: 'first.last@linked_domain' });
    candidates.push({ local: `${first[0]}${last}`, rule: 'first_initial_last@linked_domain' });
  }
  const result: Array<{ email: string; rule: string }> = [];
  for (const candidate of candidates) {
    try {
      const email = normalizeEmail(`${candidate.local.toLowerCase().replace(/[^a-z0-9._+-]/g, '')}@${domain}`);
      if (!known.has(email) && !result.some((item) => item.email === email)) result.push({ email, rule: candidate.rule });
    } catch { /* ignore invalid guesses */ }
    if (result.length === 3) break;
  }
  return result;
}
