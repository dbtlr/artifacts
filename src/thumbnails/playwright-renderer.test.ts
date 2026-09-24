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

// Needs a real Chromium: skipped where none is found (see resolveChromiumPath).
describe.skipIf(chromiumPath === undefined)('createPlaywrightRenderer', () => {
  let server: ServerType;
  let baseUrl: string;
  let renderer: ThumbnailRenderer;

  beforeAll(async () => {
    const app = new Hono();
    app.get('/a/page', (c) =>
      c.html('<!doctype html><body style="background:#123456;margin:0"><h1>hello</h1></body>'),
    );
    app.get('/a/image', (c) => c.body(PNG.buffer, 200, { 'Content-Type': 'image/png' }));
    app.get('/a/pdf', (c) =>
      c.body('%PDF-1.4 not really a pdf', 200, { 'Content-Type': 'application/pdf' }),
    );
    server = serve({ fetch: app.fetch, port: 0 });
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Expected a TCP address');
    }
    baseUrl = `http://127.0.0.1:${String(address.port)}`;
    renderer = createPlaywrightRenderer({ executablePath: chromiumPath });
  });

  afterAll(async () => {
    await renderer.close();
    await promisify(server.close.bind(server))();
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
});
