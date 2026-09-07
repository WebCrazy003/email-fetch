import { describe, expect, it } from 'vitest';
import { importUsersSchema, MAX_IMPORT_USERS } from './index.js';

const user = { name: ' Jane Doe ', email: ' Jane@Example.com ', country: ' Poland ' };

describe('JSON user import validation', () => {
  it('accepts a single user and supplies optional metadata defaults', () => {
    expect(importUsersSchema.parse(user)).toEqual([{
      name: 'Jane Doe', email: 'Jane@Example.com', country: 'Poland', extra_info: '',
      fetch_source: 'github_hire_me', fetch_page_link: ''
    }]);
  });

  it('accepts arrays and preserves all provided metadata', () => {
    const record = { name: '', email: 'jane@example.com', country: '', extra_info: 'Developer\nAvailable now', fetch_source: 'custom_directory', fetch_page_link: 'https://example.com/jane' };
    expect(importUsersSchema.parse([record])).toEqual([record]);
  });

  it.each([null, {}, [], 'text', { ...user, email: '' }, { ...user, email: 'invalid' }, { ...user, country: 123 }, { ...user, name: null }, { ...user, fetch_source: '' }])('rejects invalid input: %j', (input) => {
    expect(importUsersSchema.safeParse(input).success).toBe(false);
  });

  it.each(['javascript:alert(1)', 'data:text/html,test', 'file:///etc/passwd', 'not a url'])('rejects unsafe or invalid source links: %s', (fetch_page_link) => {
    expect(importUsersSchema.safeParse({ ...user, fetch_page_link }).success).toBe(false);
  });

  it('identifies the invalid row in a batch', () => {
    const parsed = importUsersSchema.safeParse([user, { ...user, email: 'invalid' }]);
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues[0].path).toEqual([1, 'email']);
  });

  it('bounds the batch size', () => {
    expect(importUsersSchema.safeParse(Array(MAX_IMPORT_USERS + 1).fill(user)).success).toBe(false);
  });
});
