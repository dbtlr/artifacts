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
import { createArtifactStore, createByteNativeArtifactService } from './data/store.js';

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

describe('homepage and project list', () => {
  let dataDir: string;
  let store: ArtifactStore;
  let testApp: ReturnType<typeof createApp>;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'artifacts-list-'));
    store = await createArtifactStore({
      databasePath: join(dataDir, 'artifacts.db'),
      filesDir: join(dataDir, 'artifacts'),
    });
    testApp = createApp(store);
  });

  afterEach(async () => {
    await rm(dataDir, { force: true, recursive: true });
  });

  describe('get /', () => {
    it('shows a friendly empty state on a fresh install', async () => {
      const res = await testApp.request('/');

      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain('/assets/app.css');
      expect(body).toContain('No artifacts yet');
      expect(body).not.toContain('<a href="/a/');
    });

    it('lists all artifacts newest-first with links to /a/:id and /p/:project', async () => {
      const first = store.createArtifact({
        content: 'a',
        description: 'First one',
        project: 'artifacts',
        title: 'First',
        type: 'txt',
      });
      const second = store.createArtifact({
        content: 'b',
        description: 'Second one',
        project: 'side project',
        title: 'Second',
        type: 'txt',
      });

      const res = await testApp.request('/');

      expect(res.status).toBe(200);
      const body = await res.text();

      // Newest first: second appears before first.
      expect(body.indexOf(second.title)).toBeLessThan(body.indexOf(first.title));

      expect(body).toContain(`href="/a/${first.id}"`);
      expect(body).toContain(`href="/a/${second.id}"`);
      expect(body).toContain('href="/p/artifacts"');
      // A project name with a space must be percent-encoded in the link.
      expect(body).toContain(`href="/p/${encodeURIComponent('side project')}"`);
      expect(body).toContain('href="/p/side%20project"');

      expect(body).toContain('First one');
      expect(body).toContain('Second one');
    });

    it('escapes HTML-ish title, project, and description text', async () => {
      store.createArtifact({
        content: 'x',
        description: '<img src=x onerror=alert(1)>',
        project: '<b>bold project</b>',
        title: '<script>alert("xss")</script>',
        type: 'txt',
      });

      const res = await testApp.request('/');

      const body = await res.text();
      expect(body).not.toContain('<script>alert("xss")</script>');
      expect(body).not.toContain('<img src=x onerror=alert(1)>');
      expect(body).not.toContain('<b>bold project</b>');
      expect(body).toContain('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
      expect(body).toContain('&lt;img src=x onerror=alert(1)&gt;');
      expect(body).toContain('&lt;b&gt;bold project&lt;/b&gt;');
    });
  });

  describe('get /p/:project', () => {
    it('filters to the given project and decodes a url-encoded project name', async () => {
      const inProject = store.createArtifact({
        content: 'a',
        description: 'In the target project',
        project: 'side project',
        title: 'In Project',
        type: 'txt',
      });
      const otherProject = store.createArtifact({
        content: 'b',
        description: 'In a different project',
        project: 'other',
        title: 'Other Project',
        type: 'txt',
      });

      const res = await testApp.request(`/p/${encodeURIComponent('side project')}`);

      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain(`href="/a/${inProject.id}"`);
      expect(body).not.toContain(`href="/a/${otherProject.id}"`);
      expect(body).toContain('side project');
      expect(body).not.toContain('Other Project');
    });

    it('filters to a project name containing a slash', async () => {
      const nested = store.createArtifact({
        content: 'a',
        description: 'Nested project',
        project: 'team/sub-project',
        title: 'Nested',
        type: 'txt',
      });

      const res = await testApp.request(`/p/${encodeURIComponent('team/sub-project')}`);

      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain(`href="/a/${nested.id}"`);
    });

    it('links back to all artifacts and shows the project name in the header', async () => {
      store.createArtifact({
        content: 'a',
        description: 'd',
        project: 'artifacts',
        title: 'A',
        type: 'txt',
      });

      const res = await testApp.request('/p/artifacts');

      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain('href="/"');
      expect(body).toContain('artifacts');
    });

    it('shows the empty-state list UI (not a 404) for an unknown project', async () => {
      const res = await testApp.request('/p/does-not-exist');

      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain('/assets/app.css');
      expect(body).toContain('No artifacts');
      expect(body).not.toContain('<a href="/a/');
    });
  });
});

describe('get /a/:id', () => {
  let dataDir: string;
  let store: ArtifactStore;
  let testApp: ReturnType<typeof createApp>;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'artifacts-app-'));
    store = await createArtifactStore({
      databasePath: join(dataDir, 'artifacts.db'),
      filesDir: join(dataDir, 'artifacts'),
    });
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
      content: '# Heading\n\n<script>alert("xss")</script>\n\n```ts\nconst x = 1;\n```\n',
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
    // Metadata header stays escaped, same as any other artifact type.
    expect(body).toContain('My Markdown');
    expect(body).toContain('display-route');
    expect(body).toContain('Has a script tag');
    // Markdown body is rendered, not dumped in a <pre>, and its one heading
    // got a slugged anchor id (see markdown.test.ts for the full behavior).
    expect(body).toContain('<h1 id="heading-heading">Heading</h1>');
    expect(body).toContain('class="shiki');
    // The pipeline neutralizes inline HTML (markdown-it's html:false) — it
    // never reaches the response as a live tag, only as escaped text.
    expect(body).not.toContain('<script>alert("xss")</script>');
    expect(body).toContain('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
    // A single heading isn't enough for a TOC, and there's no mermaid fence.
    expect(body).not.toContain('class="toc"');
    expect(body).not.toContain('/assets/mermaid.js');
  });

  it('renders a mermaid fence as a client-rendered diagram and links the mermaid script', async () => {
    const artifact = store.createArtifact({
      content: '# Diagram\n\n```mermaid\nflowchart TD\n  A --> B\n```\n',
      description: 'Has a mermaid diagram',
      project: 'display-route',
      title: 'My Diagram',
      type: 'md',
    });

    const res = await testApp.request(`/a/${artifact.id}`);

    const body = await res.text();
    expect(body).toContain('<pre class="mermaid">flowchart TD');
    expect(body).not.toContain('class="shiki');
    expect(body).toContain('<script src="/assets/mermaid.js" type="module">');
  });

  it('does not link the mermaid script on an md page with no mermaid fence', async () => {
    const artifact = store.createArtifact({
      content: '# No Diagram\n\nJust text and a ```ts\nconst x = 1;\n``` fence.\n',
      description: 'No mermaid here',
      project: 'display-route',
      title: 'No Diagram',
      type: 'md',
    });

    const res = await testApp.request(`/a/${artifact.id}`);

    const body = await res.text();
    expect(body).not.toContain('/assets/mermaid.js');
  });

  it('renders a table of contents between the metadata header and the content for 2+ headings', async () => {
    const artifact = store.createArtifact({
      content: '# Title\n\n## Section One\n\ntext\n\n## Section Two\n\nmore text\n',
      description: 'Has multiple headings',
      project: 'display-route',
      title: 'Multi Heading',
      type: 'md',
    });

    const res = await testApp.request(`/a/${artifact.id}`);

    const body = await res.text();
    expect(body).toContain('class="toc"');
    expect(body).toContain('href="#heading-section-one"');
    expect(body).toContain('href="#heading-section-two"');
    // Between metadata header and content: the header's description text
    // appears before the TOC, and the TOC appears before the rendered body.
    const descriptionIndex = body.indexOf('Has multiple headings');
    const tocIndex = body.indexOf('class="toc"');
    const contentIndex = body.indexOf('Section One</h2>');
    expect(descriptionIndex).toBeLessThan(tocIndex);
    expect(tocIndex).toBeLessThan(contentIndex);
  });

  it('omits the table of contents for an md page with fewer than 2 headings', async () => {
    const artifact = store.createArtifact({
      content: '# Only Heading\n\nJust one heading and some text.\n',
      description: 'Single heading',
      project: 'display-route',
      title: 'Single Heading',
      type: 'md',
    });

    const res = await testApp.request(`/a/${artifact.id}`);

    const body = await res.text();
    expect(body).not.toContain('class="toc"');
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
  const originalPublicBaseUrl = process.env.ARTIFACTS_PUBLIC_BASE_URL;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'artifacts-round-trip-'));
    store = await createArtifactStore({
      databasePath: join(dataDir, 'artifacts.db'),
      filesDir: join(dataDir, 'artifacts'),
    });
    const mcpService = await createByteNativeArtifactService({
      databasePath: join(dataDir, 'artifacts.db'),
      filesDir: join(dataDir, 'artifacts'),
    });
    const roundTripApp = createApp(store, mcpService);

    server = serve({ fetch: roundTripApp.fetch, port: 0 });
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected serve() to bind a network address');
    }
    baseOrigin = `http://localhost:${String(address.port)}`;
    process.env.ARTIFACTS_PUBLIC_BASE_URL = baseOrigin;

    client = new Client({ name: 'artifacts-round-trip-client', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${baseOrigin}/mcp`)));
  });

  afterAll(async () => {
    await client.close();
    await promisify(server.close.bind(server))();
    await rm(dataDir, { force: true, recursive: true });
    if (originalPublicBaseUrl === undefined) {
      delete process.env.ARTIFACTS_PUBLIC_BASE_URL;
    } else {
      process.env.ARTIFACTS_PUBLIC_BASE_URL = originalPublicBaseUrl;
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
