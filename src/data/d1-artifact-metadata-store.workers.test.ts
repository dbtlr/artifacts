import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vite-plus/test';

import { CreateOutcomeUnknownError } from '../artifacts/errors.js';
import type { Artifact, StoredMarkdownRendering } from '../artifacts/types.js';
import { metadataStoreContract } from './artifact-store-contract.test-support.js';
import { D1ArtifactMetadataStore } from './d1-artifact-metadata-store.js';
import type { D1PreparedStatementBinding } from './d1-database.js';
import { R2ArtifactContentStore } from './r2-artifact-content-store.js';
import { emptyBucket } from './r2-bucket.test-support.js';
import { R2ThumbnailStore } from './r2-thumbnail-store.js';

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
  await applyD1Migrations(env.MUNINN_DB, env.TEST_MIGRATIONS);
  await env.MUNINN_DB.prepare('DELETE FROM artifacts').run();
  await emptyBucket(env.MUNINN_BUCKET);
});

function newStore(): D1ArtifactMetadataStore {
  return new D1ArtifactMetadataStore(env.MUNINN_DB, env.MUNINN_BUCKET);
}

metadataStoreContract('d1', async () => newStore());

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
  return new D1ArtifactMetadataStore(
    { prepare: (query) => faulty(env.MUNINN_DB.prepare(query)) },
    env.MUNINN_BUCKET,
  );
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

    await expect(newStore().find(artifact.id)).resolves.toBeNull();
  });

  it('rejects with an unknown outcome when its row cannot be checked', async () => {
    const insertError = new Error('D1 unavailable');
    const store = storeWithFaults({
      first: async () => {
        throw new Error('D1 read failed');
      },
      run: async () => {
        throw insertError;
      },
    });

    const rejection = await store.create(artifact).catch((error) => error);

    expect(rejection).toBeInstanceOf(CreateOutcomeUnknownError);
    expect(rejection).toMatchObject({ cause: insertError });
  });
});

const rendering: StoredMarkdownRendering = {
  hasHighlightableCode: true,
  hasMermaid: false,
  html: '<h1 id="a">A</h1>',
  rendererVersion: 3,
  toc: '[{"id":"a"}]',
};

const renderingKey = `renderings/${artifact.id}`;

describe('D1ArtifactMetadataStore renderings', () => {
  beforeEach(() => newStore().create(artifact));

  it('round-trips a rendering larger than a D1 row can hold', async () => {
    const large = { ...rendering, html: 'x'.repeat(3 * 1024 * 1024) };
    const store = newStore();

    await store.saveRendering(artifact.id, large);

    await expect(store.findRendering(artifact.id)).resolves.toEqual(large);
  });

  it('keeps no HTML or table of contents in the D1 row', async () => {
    await newStore().saveRendering(artifact.id, rendering);

    const row = await env.MUNINN_DB.prepare('SELECT * FROM artifact_renderings').first();

    expect(row).toMatchObject({
      has_highlightable_code: 1,
      has_mermaid: 0,
      html: '',
      renderer_version: 3,
      toc: null,
    });
  });

  it('reads a rendering whose blob is missing as null', async () => {
    const store = newStore();
    await store.saveRendering(artifact.id, rendering);
    await env.MUNINN_BUCKET.delete(renderingKey);

    await expect(store.findRendering(artifact.id)).resolves.toBeNull();
  });

  it('reads a rendering whose blob does not parse as null', async () => {
    const store = newStore();
    await store.saveRendering(artifact.id, rendering);
    await env.MUNINN_BUCKET.put(renderingKey, new TextEncoder().encode('not json'));

    await expect(store.findRendering(artifact.id)).resolves.toBeNull();
  });

  it('reads a rendering whose blob has another renderer version than its row as null', async () => {
    const store = newStore();
    await store.saveRendering(artifact.id, rendering);
    await store.saveRendering(artifact.id, { ...rendering, rendererVersion: 2 });
    // The other writer's row lands last, as in an interleaved mixed-version rollout.
    await env.MUNINN_DB.prepare('UPDATE artifact_renderings SET renderer_version = 3').run();

    await expect(store.findRendering(artifact.id)).resolves.toBeNull();
  });

  it('deletes the blob when the artifact is removed', async () => {
    const store = newStore();
    await store.saveRendering(artifact.id, rendering);

    await expect(store.remove(artifact.id)).resolves.toBe(true);

    await expect(env.MUNINN_BUCKET.head(renderingKey)).resolves.toBeNull();
  });

  it('still reports a removal when the blob cannot be deleted', async () => {
    await newStore().saveRendering(artifact.id, rendering);
    const store = new D1ArtifactMetadataStore(env.MUNINN_DB, {
      delete: async () => {
        throw new Error('R2 unavailable');
      },
      get: (key) => env.MUNINN_BUCKET.get(key),
      head: (key) => env.MUNINN_BUCKET.head(key),
      put: (key, value) => env.MUNINN_BUCKET.put(key, value),
    });

    await expect(store.remove(artifact.id)).resolves.toBe(true);

    await expect(store.find(artifact.id)).resolves.toBeNull();
  });

  it('leaves no blob when saving for a missing artifact', async () => {
    const store = newStore();

    await store.saveRendering('missing', rendering);

    await expect(env.MUNINN_BUCKET.head('renderings/missing')).resolves.toBeNull();
    await expect(store.findRendering('missing')).resolves.toBeNull();
  });

  it('leaves no blob when the artifact is removed between the two writes of a save', async () => {
    let removed = false;
    // Removes the artifact once, right after the save's first write, whichever
    // store that write goes to: written row-first, the blob would land after
    // the removal and never be deleted.
    async function removeAfterFirstWrite<T>(write: Promise<T>): Promise<T> {
      const result = await write;
      if (!removed) {
        removed = true;
        await newStore().remove(artifact.id);
      }
      return result;
    }
    function interleaved(statement: D1PreparedStatementBinding): D1PreparedStatementBinding {
      return {
        all: () => statement.all(),
        bind: (...values) => interleaved(statement.bind(...values)),
        first: () => statement.first(),
        run: () => removeAfterFirstWrite(statement.run()),
      };
    }
    const store = new D1ArtifactMetadataStore(
      { prepare: (query) => interleaved(env.MUNINN_DB.prepare(query)) },
      {
        delete: (key) => env.MUNINN_BUCKET.delete(key),
        get: (key) => env.MUNINN_BUCKET.get(key),
        head: (key) => env.MUNINN_BUCKET.head(key),
        put: (key, value) => removeAfterFirstWrite(env.MUNINN_BUCKET.put(key, value)),
      },
    );

    await store.saveRendering(artifact.id, rendering);

    expect(removed).toBe(true);
    await expect(env.MUNINN_BUCKET.head(renderingKey)).resolves.toBeNull();
  });

  it('shares a bucket with the content and thumbnail stores without touching their objects', async () => {
    const content = new R2ArtifactContentStore(env.MUNINN_BUCKET);
    const thumbnails = new R2ThumbnailStore(env.MUNINN_BUCKET);
    await content.write(artifact.id, 'image/jpeg', Uint8Array.from([1]));
    await thumbnails.write(artifact.id, Uint8Array.from([2]));
    const store = newStore();
    await store.saveRendering(artifact.id, rendering);

    await store.remove(artifact.id);

    await expect(content.read(artifact.id, 'image/jpeg')).resolves.toEqual(Uint8Array.from([1]));
    await expect(thumbnails.read(artifact.id)).resolves.toEqual(Uint8Array.from([2]));
  });
});
