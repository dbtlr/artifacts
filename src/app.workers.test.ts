import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vite-plus/test';

import { createApp } from './app.js';
import { createArtifactService } from './artifacts/service.js';
import { D1ArtifactMetadataStore } from './data/d1-artifact-metadata-store.js';
import { R2ArtifactContentStore } from './data/r2-artifact-content-store.js';
import { emptyBucket } from './data/r2-bucket.test-support.js';

// The requests prove the app serves from the Worker adapters under workerd.
// Loading it is a weak import guard: workerd's nodejs_compat provides node:fs
// and the test pool resolves node:sqlite, so a Worker bundle build is the
// stronger check.
beforeEach(async () => {
  await applyD1Migrations(env.MUNINN_DB, env.TEST_MIGRATIONS);
  await env.MUNINN_DB.prepare('DELETE FROM artifacts').run();
  await emptyBucket(env.MUNINN_BUCKET);
});

function workerApp() {
  const artifacts = createArtifactService(
    new D1ArtifactMetadataStore(env.MUNINN_DB),
    new R2ArtifactContentStore(env.MUNINN_BUCKET),
  );
  return { app: createApp({ artifacts, mcp: artifacts }), artifacts };
}

describe('app on the Workers runtime', () => {
  it('renders the homepage', async () => {
    const res = await workerApp().app.request('/');

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    await expect(res.text()).resolves.toContain('Muninn');
  });

  it('serves a stored artifact with its content', async () => {
    const { app, artifacts } = workerApp();
    const artifact = await artifacts.createArtifact({
      content: new TextEncoder().encode('kept in R2'),
      description: 'worker test',
      mediaType: 'text/plain',
      project: 'workers',
      title: 'Stored',
    });

    const res = await app.request(`/a/${artifact.id}`);

    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toContain('kept in R2');
  });

  it('answers an MCP initialize request', async () => {
    const res = await workerApp().app.request('/mcp', {
      body: JSON.stringify({
        id: 1,
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          capabilities: {},
          clientInfo: { name: 'workers-test', version: '0' },
          protocolVersion: '2025-03-26',
        },
      }),
      headers: {
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
      },
      method: 'POST',
    });

    expect(res.status).toBe(200);
  });
});
