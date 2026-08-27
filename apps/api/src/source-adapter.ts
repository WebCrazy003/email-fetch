import type { CollectionFilters } from '@email-fetch/shared';

export interface SourceCandidate {
  id: string | number;
  login: string;
}

export interface SourceAdapter<Candidate extends SourceCandidate = SourceCandidate, Profile = unknown> {
  readonly sourceKey: string;
  readonly adapterVersion: string;
  discover(filters: CollectionFilters): AsyncGenerator<Candidate>;
  profile(login: string): Promise<Profile>;
}

export class SourceAdapterRegistry {
  private readonly adapters = new Map<string, SourceAdapter>();

  register(adapter: SourceAdapter) {
    if (this.adapters.has(adapter.sourceKey)) throw new Error(`Source adapter already registered: ${adapter.sourceKey}`);
    this.adapters.set(adapter.sourceKey, adapter);
  }

  get<T extends SourceAdapter = SourceAdapter>(sourceKey: string): T {
    const adapter = this.adapters.get(sourceKey);
    if (!adapter) throw new Error(`Source adapter is not registered: ${sourceKey}`);
    return adapter as T;
  }

  keys() {
    return [...this.adapters.keys()];
  }
}
