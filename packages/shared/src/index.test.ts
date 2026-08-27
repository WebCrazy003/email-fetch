import { describe, expect, it } from 'vitest';
import { collectionFiltersSchema, normalizeEmail, userQuerySchema } from './index.js';

describe('normalizeEmail', () => {
  it('trims and lowercases the complete address', () => {
    expect(normalizeEmail('  Jane.Doe@Example.COM ')).toBe('jane.doe@example.com');
  });

  it('rejects invalid addresses', () => {
    expect(() => normalizeEmail('not-an-email')).toThrow('Invalid email address');
  });
});

describe('collectionFiltersSchema', () => {
  it('enforces the per-job maximum', () => {
    expect(collectionFiltersSchema.safeParse({ maxUsers: 10_001 }).success).toBe(false);
  });

  it('rejects reversed ranges', () => {
    expect(collectionFiltersSchema.safeParse({ followersMin: 10, followersMax: 2 }).success).toBe(false);
  });
});

describe('query booleans', () => {
  it('parses explicit false without JavaScript string coercion', () => {
    expect(userQuerySchema.parse({ suppressed: 'false', recordHistory: 'false' })).toMatchObject({
      suppressed: false,
      recordHistory: false
    });
  });
});
