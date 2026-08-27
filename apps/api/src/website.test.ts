import { describe, expect, it } from 'vitest';
import { guessEmails } from './website.js';

describe('guessEmails', () => {
  it('creates no more than three normalized candidates', () => {
    expect(guessEmails('Jane Doe', 'JaneD', 'https://www.example.com/about', [])).toEqual([
      { email: 'janed@example.com', rule: 'github_login@linked_domain' },
      { email: 'jane.doe@example.com', rule: 'first.last@linked_domain' },
      { email: 'jdoe@example.com', rule: 'first_initial_last@linked_domain' }
    ]);
  });
});
