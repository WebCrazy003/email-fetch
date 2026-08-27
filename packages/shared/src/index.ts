import { z } from 'zod';

export const confidenceSchema = z.enum(['confirmed', 'likely', 'unsure']);
export type Confidence = z.infer<typeof confidenceSchema>;

export const discoveryTypeSchema = z.enum(['source_profile', 'linked_website', 'guessed']);
export type DiscoveryType = z.infer<typeof discoveryTypeSchema>;

const optionalInteger = z.coerce.number().int().nonnegative().optional();
const optionalDate = z.string().date().optional();
const queryBoolean = z.preprocess((value) => {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}, z.boolean());

export const collectionFiltersSchema = z
  .object({
    location: z.string().trim().max(120).optional(),
    language: z.string().trim().max(60).optional(),
    followersMin: optionalInteger,
    followersMax: optionalInteger,
    repositoriesMin: optionalInteger,
    repositoriesMax: optionalInteger,
    createdFrom: optionalDate,
    createdTo: optionalDate,
    activityFrom: optionalDate,
    activityTo: optionalDate,
    keywords: z.array(z.string().trim().min(1).max(80)).max(10).default([]),
    requirePublicEmail: z.boolean().default(false),
    discoveryPolicy: z.enum(['direct', 'linked_site', 'guesses']).default('linked_site'),
    minimumConfidence: confidenceSchema.default('unsure'),
    excludePreviouslyProcessed: z.boolean().default(false),
    maxUsers: z.coerce.number().int().min(1).max(10_000).default(1_000)
  })
  .superRefine((value, context) => {
    if (value.followersMin !== undefined && value.followersMax !== undefined && value.followersMin > value.followersMax) {
      context.addIssue({ code: 'custom', path: ['followersMax'], message: 'Must be greater than or equal to the minimum' });
    }
    if (value.repositoriesMin !== undefined && value.repositoriesMax !== undefined && value.repositoriesMin > value.repositoriesMax) {
      context.addIssue({ code: 'custom', path: ['repositoriesMax'], message: 'Must be greater than or equal to the minimum' });
    }
    if (value.createdFrom && value.createdTo && value.createdFrom > value.createdTo) {
      context.addIssue({ code: 'custom', path: ['createdTo'], message: 'Must be on or after the start date' });
    }
  });

export type CollectionFilters = z.infer<typeof collectionFiltersSchema>;

export const createFilterSchema = z.object({
  name: z.string().trim().min(1).max(120),
  source: z.literal('github').default('github'),
  filters: collectionFiltersSchema
});
export type CreateFilterInput = z.infer<typeof createFilterSchema>;

export const jobStatusSchema = z.enum([
  'queued',
  'running',
  'paused',
  'rate_limited',
  'completed',
  'completed_with_errors',
  'failed',
  'cancelling',
  'cancelled'
]);
export type JobStatus = z.infer<typeof jobStatusSchema>;

export const userQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  location: z.string().trim().max(120).optional(),
  company: z.string().trim().max(120).optional(),
  source: z.literal('github').optional(),
  jobId: z.string().uuid().optional(),
  emailStatus: z.enum(['active', 'no_longer_public', 'invalid', 'suppressed', 'deleted']).optional(),
  confidence: confidenceSchema.optional(),
  discoveryType: discoveryTypeSchema.optional(),
  sendStatus: z.enum(['never_sent', 'sent', 'failed_latest_attempt', 'suppressed']).optional(),
  suppressed: queryBoolean.optional(),
  sort: z.enum(['last_checked', 'first_seen', 'login', 'followers']).default('last_checked'),
  order: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25)
});
export type UserQuery = z.infer<typeof userQuerySchema>;

export const emailQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  domain: z.string().trim().max(255).optional(),
  status: z.enum(['active', 'no_longer_public', 'invalid', 'suppressed', 'deleted']).optional(),
  confidence: confidenceSchema.optional(),
  discoveryType: discoveryTypeSchema.optional(),
  sendStatus: z.enum(['never_sent', 'sent', 'failed_latest_attempt', 'suppressed']).optional(),
  sort: z.enum(['email', 'first_seen', 'last_seen', 'last_sent']).default('last_seen'),
  order: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25)
});
export type EmailQuery = z.infer<typeof emailQuerySchema>;

export const createEmailSchema = z.object({
  email: z.string().trim().email(),
  personId: z.string().uuid().optional(),
  confidence: confidenceSchema.default('confirmed'),
  discoveryType: discoveryTypeSchema.default('source_profile')
});

export function normalizeEmail(value: string): string {
  const trimmed = value.trim();
  const at = trimmed.lastIndexOf('@');
  if (at <= 0 || at === trimmed.length - 1) throw new Error('Invalid email address');
  const local = trimmed.slice(0, at).toLowerCase();
  const domain = new URL(`http://${trimmed.slice(at + 1)}`).hostname.toLowerCase();
  const normalized = `${local}@${domain}`;
  if (!z.string().email().safeParse(normalized).success) throw new Error('Invalid email address');
  return normalized;
}

export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

export interface JobCounters {
  candidatesDiscovered: number;
  usersInspected: number;
  usersWithPublicEmail: number;
  confirmedEmails: number;
  likelyEmails: number;
  unsureEmails: number;
  guessedEmails: number;
  newUsers: number;
  updatedUsers: number;
  duplicateEmails: number;
  suppressed: number;
  skipped: number;
  requests: number;
  retries: number;
  errors: number;
}

export const emptyJobCounters = (): JobCounters => ({
  candidatesDiscovered: 0,
  usersInspected: 0,
  usersWithPublicEmail: 0,
  confirmedEmails: 0,
  likelyEmails: 0,
  unsureEmails: 0,
  guessedEmails: 0,
  newUsers: 0,
  updatedUsers: 0,
  duplicateEmails: 0,
  suppressed: 0,
  skipped: 0,
  requests: 0,
  retries: 0,
  errors: 0
});
