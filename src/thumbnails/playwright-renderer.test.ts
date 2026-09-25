import { once } from 'node:events';
import { promisify } from 'node:util';

import type { ServerType } from '@hono/node-server';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';

import { createPlaywrightRenderer, resolveChromiumPath } from './playwright-renderer.js';
import type { ThumbnailRenderer } from './types.js';

const chromiumPath = await resolveChromiumPath(process.env);

// A 1x1 PNG, enough for Chromium to render an <img>-style image page.
const PNG = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  ),
  (char) => char.charCodeAt(0),
);

const JPEG_MAGIC = [255, 216, 255];

async function listen(app: Hono): Promise<{ server: ServerType; url: string }> {
  const server = serve({ fetch: app.fetch, port: 0 });
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Expected a TCP address');
  }
  return { server, url: `http://127.0.0.1:${String(address.port)}` };
}

describe('createPlaywrightRenderer without a Chromium', () => {
  it('reports the failed launch once and declines every render', async () => {
    const reported: string[] = [];
    const renderer = createPlaywrightRenderer({
      executablePath: '/nonexistent/chromium',
      report: (message) => {
        reported.push(message);
      },
    });
    const target = { id: 'x', mediaType: 'text/html' as const, url: 'http://127.0.0.1:1/a/x' };

    await expect(renderer.render(target)).resolves.toBeNull();
    await expect(renderer.render(target)).resolves.toBeNull();

    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatch(/^Thumbnail rendering disabled, Chromium failed to launch: /u);
    await renderer.close();
  });
});

// Needs a real Chromium: skipped where none is found (see resolveChromiumPath).
describe.skipIf(chromiumPath === undefined)('createPlaywrightRenderer', () => {
  let server: ServerType;
  let baseUrl: string;
  // A second origin standing in for a loopback neighbour the render context
  // must never reach.
  let neighbour: ServerType;
  let neighbourUrl: string;
  let neighbourHits = 0;
  let mcpPosts = 0;
  let renderer: ThumbnailRenderer;

  beforeAll(async () => {
    const other = new Hono();
    other.all('*', (c) => {
      neighbourHits += 1;
      return c.text('INTERNAL');
    });
    ({ server: neighbour, url: neighbourUrl } = await listen(other));

    const app = new Hono();
    app.get('/a/page', (c) =>
      c.html('<!doctype html><body style="background:#123456;margin:0"><h1>hello</h1></body>'),
    );
    app.get('/a/image', (c) => c.body(PNG.buffer, 200, { 'Content-Type': 'image/png' }));
    app.get('/a/pdf', (c) =>
      c.body('%PDF-1.4 not really a pdf', 200, { 'Content-Type': 'application/pdf' }),
    );
    app.post('/mcp', (c) => {
      mcpPosts += 1;
      return c.json({});
    });
    app.get('/a/leaky', (c) =>
      c.html(
        `<!doctype html><body><iframe src="${neighbourUrl}/"></iframe><img src="${neighbourUrl}/i.png">` +
          `<script>fetch('/mcp',{method:'POST',body:'{}'});fetch('${neighbourUrl}/f');</script></body>`,
      ),
    );
    // Never answers, so the page never reaches network idle.
    app.get('/a/drip', () => Promise.withResolvers<Response>().promise);
    app.get('/a/slow', (c) =>
      c.html('<!doctype html><body><script>fetch("/a/drip")</script>slow</body>'),
    );
    ({ server, url: baseUrl } = await listen(app));
    renderer = createPlaywrightRenderer({ executablePath: chromiumPath });
  });

  afterAll(async () => {
    await renderer.close();
    await promisify(server.close.bind(server))();
    await promisify(neighbour.close.bind(neighbour))();
  });

  it('screenshots an html page as a JPEG', async () => {
    const bytes = await renderer.render({
      id: 'page',
      mediaType: 'text/html',
      url: `${baseUrl}/a/page`,
    });

    expect(bytes).not.toBeNull();
    expect([...bytes!.subarray(0, 3)]).toEqual(JPEG_MAGIC);
  });

  it('screenshots an image served as bytes', async () => {
    const bytes = await renderer.render({
      id: 'image',
      mediaType: 'image/png',
      url: `${baseUrl}/a/image`,
    });

    expect(bytes).not.toBeNull();
    expect([...bytes!.subarray(0, 3)]).toEqual(JPEG_MAGIC);
  });

  it('declines a PDF instead of throwing', async () => {
    const bytes = await renderer.render({
      id: 'pdf',
      mediaType: 'application/pdf',
      url: `${baseUrl}/a/pdf`,
    });

    expect(bytes).toBeNull();
  });

  it('blocks every request that is not a GET to the artifact origin', async () => {
    const bytes = await renderer.render({
      id: 'leaky',
      mediaType: 'text/html',
      url: `${baseUrl}/a/leaky`,
    });

    expect(bytes).not.toBeNull();
    expect(neighbourHits).toBe(0);
    expect(mcpPosts).toBe(0);
  });

  it('abandons a page that never settles once the deadline passes', async () => {
    const impatient = createPlaywrightRenderer({ executablePath: chromiumPath, timeoutMs: 1500 });
    const started = Date.now();

    await expect(
      impatient.render({ id: 'slow', mediaType: 'text/html', url: `${baseUrl}/a/slow` }),
    ).rejects.toThrow(/closed|Timeout/u);

    expect(Date.now() - started).toBeLessThan(4000);
    await impatient.close();
  });
});
