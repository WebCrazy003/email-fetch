import { describe, expect, it } from 'vitest';
import type { CollectionFilters } from '@email-fetch/shared';
import { SourceAdapterRegistry, type SourceAdapter } from './source-adapter.js';

class DummyAdapter implements SourceAdapter {
  readonly sourceKey = 'dummy';
  readonly adapterVersion = '1.0.0';
  async *discover(_filters: CollectionFilters) { yield { id: '1', login: 'dummy-user' }; }
  async profile(login: string) { return { login }; }
}

describe('SourceAdapterRegistry', () => {
  it('registers a second adapter without changing shared persistence tables', () => {
    const registry = new SourceAdapterRegistry();
    registry.register(new DummyAdapter());
    expect(registry.keys()).toEqual(['dummy']);
    expect(registry.get('dummy').adapterVersion).toBe('1.0.0');
  });
});
