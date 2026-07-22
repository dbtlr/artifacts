import { once } from 'node:events';
import { mkdtemp, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { ServerType } from '@hono/node-server';
import { serve } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import { z } from 'zod';

import { app, createApp } from './app.js';
import type { ArtifactStore } from './data/store.js';
import { createArtifactStore } from './data/store.js';

describe('app', () => {
  it('renders the homepage with the stylesheet linked', async () => {
    const res = await app.request('/');

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const body = await res.text();
    expect(body).toContain('Artifacts');
    expect(body).toContain('/assets/app.css');
  });
});

describe('get /a/:id', () => {
  let dataDir: string;
  let store: ArtifactStore;
  let testApp: ReturnType<typeof createApp>;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'artifacts-app-'));
    store = createArtifactStore(dataDir);
    testApp = createApp(store);
  });

  afterEach(async () => {
    await rm(dataDir, { force: true, recursive: true });
  });

  it('serves an html artifact verbatim, with no layout wrapper', async () => {
    const htmlContent = '<!doctype html><html><body><h1>Hi</h1></body></html>';
    const artifact = store.createArtifact({
      content: htmlContent,
      description: 'A raw html doc',
      project: 'display-route',
      title: 'Raw HTML',
      type: 'html',
    });

    const res = await testApp.request(`/a/${artifact.id}`);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const body = await res.text();
    expect(body).toBe(htmlContent);
  });

  it('renders an md artifact inside the layout, with content escaped', async () => {
    const artifact = store.createArtifact({
      content: '# Heading\n\n<script>alert("xss")</script>',
      description: 'Has a script tag',
      project: 'display-route',
      title: 'My Markdown',
      type: 'md',
    });

    const res = await testApp.request(`/a/${artifact.id}`);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const body = await res.text();
    expect(body).toContain('/assets/app.css');
    expect(body).toContain('My Markdown');
    expect(body).toContain('display-route');
    expect(body).toContain('Has a script tag');
    expect(body).not.toContain('<script>alert("xss")</script>');
    expect(body).toContain('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
  });

  it('renders a txt artifact inside the layout, with content escaped', async () => {
    const artifact = store.createArtifact({
      content: 'plain text with a <tag> in it',
      description: 'Has an angle-bracket tag',
      project: 'display-route',
      title: 'My Text',
      type: 'txt',
    });

    const res = await testApp.request(`/a/${artifact.id}`);

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('My Text');
    expect(body).toContain('plain text with a &lt;tag&gt; in it');
    expect(body).not.toContain('plain text with a <tag> in it');
  });

  it('returns a styled 404 for an unknown id', async () => {
    const res = await testApp.request('/a/does-not-exist');

    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('text/html');
    const body = await res.text();
    expect(body).toContain('/assets/app.css');
    expect(body).toContain('not found');
    expect(body).toContain('does-not-exist');
  });

  // store.getArtifact deliberately throws when a row's content file is
  // missing (see store.ts) — a corrupt-store signal, not an ordinary "not
  // found". The route must let that propagate as a 500, not mask it as a 404.
  it('surfaces a corrupt store (row present, content file missing) as a 500', async () => {
    const artifact = store.createArtifact({
      content: 'will be deleted out from under the row',
      description: 'Simulates a corrupt store',
      project: 'display-route',
      title: 'Corrupt',
      type: 'txt',
    });
    await unlink(join(dataDir, 'artifacts', `${artifact.id}.txt`));

    const res = await testApp.request(`/a/${artifact.id}`);

    expect(res.status).toBe(500);
  });
});

describe('mcp add_artifact -> display round-trip', () => {
  let dataDir: string;
  let store: ArtifactStore;
  let server: ServerType;
  let client: Client;
  let baseOrigin: string;
  const originalPublicBaseUrl = process.env.PUBLIC_BASE_URL;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'artifacts-round-trip-'));
    store = createArtifactStore(dataDir);
    const roundTripApp = createApp(store);

    server = serve({ fetch: roundTripApp.fetch, port: 0 });
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected serve() to bind a network address');
    }
    baseOrigin = `http://localhost:${String(address.port)}`;
    process.env.PUBLIC_BASE_URL = baseOrigin;

    client = new Client({ name: 'artifacts-round-trip-client', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${baseOrigin}/mcp`)));
  });

  afterAll(async () => {
    await client.close();
    await promisify(server.close.bind(server))();
    await rm(dataDir, { force: true, recursive: true });
    if (originalPublicBaseUrl === undefined) {
      delete process.env.PUBLIC_BASE_URL;
    } else {
      process.env.PUBLIC_BASE_URL = originalPublicBaseUrl;
    }
  });

  it('fetches the URL returned by add_artifact and gets the stored content', async () => {
    const raw = await client.callTool({
      arguments: {
        content: 'Round-trip body',
        description: 'Created via MCP, fetched via the display route',
        project: 'round-trip',
        title: 'Round Trip Artifact',
        type: 'txt',
      },
      name: 'add_artifact',
    });
    const result = CallToolResultSchema.parse(raw);
    const [first] = result.content;
    if (!first || first.type !== 'text') {
      throw new Error('expected a text content block');
    }
    const added = z.object({ id: z.string(), url: z.string() }).parse(JSON.parse(first.text));
    expect(added.url).toBe(`${baseOrigin}/a/${added.id}`);

    const res = await fetch(added.url);

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Round Trip Artifact');
    expect(body).toContain('Round-trip body');
  });
});
