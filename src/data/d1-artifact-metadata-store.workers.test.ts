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

// A statement whose writes commit and then report failure, as a D1 call that
// times out after its commit does.
function failingAfterCommit(statement: D1PreparedStatementBinding): D1PreparedStatementBinding {
  return {
    all: () => statement.all(),
    bind: (...values) => failingAfterCommit(statement.bind(...values)),
    first: () => statement.first(),
    run: async () => {
      await statement.run();
      throw new Error('D1 timed out');
    },
  };
}

describe('D1ArtifactMetadataStore', () => {
  it('resolves a create that committed before its call failed', async () => {
    const store = new D1ArtifactMetadataStore({
      prepare: (query) => failingAfterCommit(env.ARTIFACTS_DB.prepare(query)),
    });

    await expect(store.create(artifact)).resolves.toBeUndefined();

    await expect(store.find(artifact.id)).resolves.toEqual(artifact);
  });
});
