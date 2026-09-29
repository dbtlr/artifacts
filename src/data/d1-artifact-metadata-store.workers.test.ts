import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vite-plus/test';

import type { Artifact } from '../artifacts/types.js';
import { metadataStoreContract } from './artifact-store-contract.test-support.js';
import { D1ArtifactMetadataStore } from './d1-artifact-metadata-store.js';
import type { D1PreparedStatementBinding } from './d1-database.js';

const artifact: Artifact = {
  createdAt: '2026-01-01T00:00:00.000Z',
  description: 'committed',
  id: 'committed',
  mediaType: 'text/plain',
  project: 'alpha',
  title: 'Committed',
};

// Applies the shared migrations as `wrangler d1 migrations apply` would, then
// empties the table, so each test starts clean whatever storage isolation the
// test runtime provides.
beforeEach(async () => {
  await applyD1Migrations(env.ARTIFACTS_DB, env.TEST_MIGRATIONS);
  await env.ARTIFACTS_DB.prepare('DELETE FROM artifacts').run();
});

metadataStoreContract('d1', async () => new D1ArtifactMetadataStore(env.ARTIFACTS_DB));

type StatementFaults = {
  first?: (statement: D1PreparedStatementBinding) => Promise<Record<string, unknown> | null>;
  run?: (statement: D1PreparedStatementBinding) => Promise<{ meta: { changes: number } }>;
};

// A store over the test database whose statements call `faults` in place of
// their own `first` or `run`, to stand in for D1 calls that fail.
function storeWithFaults(faults: StatementFaults): D1ArtifactMetadataStore {
  function faulty(statement: D1PreparedStatementBinding): D1PreparedStatementBinding {
    return {
      all: () => statement.all(),
      bind: (...values) => faulty(statement.bind(...values)),
      first: () => (faults.first ? faults.first(statement) : statement.first()),
      run: () => (faults.run ? faults.run(statement) : statement.run()),
    };
  }
  return new D1ArtifactMetadataStore({
    prepare: (query) => faulty(env.ARTIFACTS_DB.prepare(query)),
  });
}

describe('D1ArtifactMetadataStore', () => {
  it('resolves a create that committed before its call failed', async () => {
    const store = storeWithFaults({
      run: async (statement) => {
        await statement.run();
        throw new Error('D1 timed out');
      },
    });

    await expect(store.create(artifact)).resolves.toBeUndefined();

    await expect(store.find(artifact.id)).resolves.toEqual(artifact);
  });

  it('rejects a create whose insert failed without storing a row', async () => {
    const store = storeWithFaults({
      run: async () => {
        throw new Error('D1 unavailable');
      },
    });

    await expect(store.create(artifact)).rejects.toThrow('D1 unavailable');

    await expect(
      new D1ArtifactMetadataStore(env.ARTIFACTS_DB).find(artifact.id),
    ).resolves.toBeNull();
  });

  it('rejects with the insert error when its row cannot be checked', async () => {
    const store = storeWithFaults({
      first: async () => {
        throw new Error('D1 read failed');
      },
      run: async () => {
        throw new Error('D1 unavailable');
      },
    });

    await expect(store.create(artifact)).rejects.toThrow('D1 unavailable');
  });
});
