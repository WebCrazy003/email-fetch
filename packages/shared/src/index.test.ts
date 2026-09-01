import { describe, expect, it } from 'vitest';
import { campaignSelectionSchema, campaignTestSchema, collectionFiltersSchema, createEmailCampaignSchema, createFilterSchema, emailQuerySchema, emailTemplateInputSchema, normalizeEmail, testEmailRecipientSchema, userQuerySchema } from './index.js';

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

describe('createFilterSchema', () => {
  it('requires a name before a filter can be saved', () => {
    expect(createFilterSchema.safeParse({ source: 'github', filters: {} }).success).toBe(false);
    expect(createFilterSchema.safeParse({ name: 'Poland JavaScript', source: 'github', filters: {} }).success).toBe(true);
  });
});

describe('query booleans', () => {
  it('parses explicit false without JavaScript string coercion', () => {
    expect(userQuerySchema.parse({ suppressed: 'false' })).toMatchObject({ suppressed: false });
  });
});

describe('email queries', () => {
  it('trims the country filter and limits its length', () => {
    expect(emailQuerySchema.parse({ country: ' Poland ' }).country).toBe('Poland');
    expect(emailQuerySchema.safeParse({ country: 'x'.repeat(121) }).success).toBe(false);
  });
});

describe('email sending schemas', () => {
  it('deduplicates and normalizes explicitly selected email IDs', () => {
    expect(campaignSelectionSchema.parse({ emailIds: [' Person@Example.com ', 'person@example.com'] }).emailIds).toEqual(['person@example.com']);
  });

  it('rejects header injection in templates and campaigns', () => {
    expect(emailTemplateInputSchema.safeParse({ name: 'Intro', subject: 'Hello\nBcc: x@example.com', bodyText: 'Hi' }).success).toBe(false);
    expect(createEmailCampaignSchema.safeParse({
      emailIds: ['person@example.com'], templateId: '52d2b647-7c9a-42b6-a1ec-77a9f4161968', name: 'Campaign', senderName: 'Richard\r\nBcc: x'
    }).success).toBe(false);
  });

  it('normalizes managed test recipients', () => {
    expect(testEmailRecipientSchema.parse({ email: ' Test.User@Example.COM ' }).email).toBe('test.user@example.com');
    expect(campaignTestSchema.parse({
      templateId: '52d2b647-7c9a-42b6-a1ec-77a9f4161968', recipient: ' Test.User@Example.COM '
    }).recipient).toBe('test.user@example.com');
  });
});
