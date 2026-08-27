import { describe, expect, it } from 'vitest';
import { buildGitHubQuery, isGitHubRelayEmail } from './github-adapter.js';

describe('buildGitHubQuery', () => {
  it('always restricts discovery to personal users', () => {
    expect(buildGitHubQuery({
      location: 'New York', language: 'TypeScript', followersMin: 10, followersMax: 100,
      repositoriesMin: 2, repositoriesMax: 20, keywords: [], requirePublicEmail: false,
      discoveryPolicy: 'linked_site', minimumConfidence: 'unsure', excludePreviouslyProcessed: false, maxUsers: 100
    }, '2020-01-01', '2020-12-31')).toBe(
      'type:user location:"New York" language:"TypeScript" followers:10..100 repos:2..20 created:2020-01-01..2020-12-31'
    );
  });

  it('rejects GitHub private relay addresses as contact emails', () => {
    expect(isGitHubRelayEmail('123+name@users.noreply.github.com')).toBe(true);
    expect(isGitHubRelayEmail('person@example.com')).toBe(false);
  });
});
