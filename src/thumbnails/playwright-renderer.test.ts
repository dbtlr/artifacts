import { createSocket } from 'node:dgram';
import type { Socket } from 'node:dgram';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

import type { ServerType } from '@hono/node-server';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';

import {
  createPlaywrightRenderer,
  proxyFencedTo,
  resolveChromiumPath,
} from './playwright-renderer.js';
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

describe('proxyFencedTo', () => {
  it('names the explicit port so a bare hostname never bypasses every port', () => {
    expect(proxyFencedTo('http://127.0.0.1:3000').bypass).toBe('<-loopback>,127.0.0.1:3000');
    expect(proxyFencedTo('http://127.0.0.1').bypass).toBe('<-loopback>,127.0.0.1:80');
    expect(proxyFencedTo('https://artifacts.internal').bypass).toBe(
      '<-loopback>,artifacts.internal:443',
    );
  });
});

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
  let neighbourUpgrades = 0;
  let udp: Socket;
  let udpPackets = 0;
  let mcpPosts = 0;
  let renderer: ThumbnailRenderer;

  beforeAll(async () => {
    const other = new Hono();
    other.all('*', (c) => {
      neighbourHits += 1;
      return c.text('INTERNAL');
    });
    ({ server: neighbour, url: neighbourUrl } = await listen(other));
    const wsUrl = neighbourUrl.replace('http', 'ws');
    // A WebSocket handshake never reaches Hono; count it at the socket layer.
    neighbour.on('upgrade', (_request, socket) => {
      neighbourUpgrades += 1;
      socket.destroy();
    });
    udp = createSocket('udp4');
    udp.on('message', () => {
      udpPackets += 1;
    });
    udp.bind(0, '127.0.0.1');
    await once(udp, 'listening');
    const udpPort = udp.address().port;

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
          // A sandboxed srcdoc frame runs in its own process, ahead of any
          // page-level countermeasure; only scripts-off covers it.
          `<iframe sandbox="allow-scripts" srcdoc="<script>const pc=new RTCPeerConnection({iceServers:[{urls:'stun:127.0.0.1:${String(udpPort)}'}]});` +
          `pc.createDataChannel('x');pc.createOffer().then(o=>pc.setLocalDescription(o));new WebSocket('${wsUrl}/ws-sandbox')</script>"></iframe>` +
          // Script canaries: none of these may run, let alone connect. Each
          // attempt stands alone, so one that throws cannot mask the rest.
          `<script>` +
          `try{fetch('/mcp',{method:'POST',body:'{}'})}catch{}` +
          `try{fetch('${neighbourUrl}/f')}catch{}` +
          `try{new WebSocket('${wsUrl}/ws')}catch{}` +
          // Workers never see Playwright's page-level WebSocket mock.
          `try{new Worker(URL.createObjectURL(new Blob(["new WebSocket('${wsUrl}/ws-worker')"],{type:'text/javascript'})))}catch{}` +
          `try{new SharedWorker(URL.createObjectURL(new Blob(["new WebSocket('${wsUrl}/ws-shared')"],{type:'text/javascript'})))}catch{}` +
          // WebRTC bypasses the proxy; ICE gathering (which needs an offer
          // and a local description) would send STUN packets to loopback.
          `try{const pc=new RTCPeerConnection({iceServers:[{urls:'stun:127.0.0.1:${String(udpPort)}'}]});` +
          `pc.createDataChannel('x');pc.createOffer().then(o=>pc.setLocalDescription(o))}catch{}` +
          `</script></body>`,
      ),
    );
    // Never answers, so the page never reaches network idle.
    app.get('/a/drip', () => Promise.withResolvers<Response>().promise);
    // Scripts are off in previews, so the never-ending request is an <img>.
    app.get('/a/slow', (c) => c.html('<!doctype html><body><img src="/a/drip">slow</body>'));
    ({ server, url: baseUrl } = await listen(app));
    renderer = createPlaywrightRenderer({ executablePath: chromiumPath });
  });

  afterAll(async () => {
    await renderer.close();
    await promisify(server.close.bind(server))();
    await promisify(neighbour.close.bind(neighbour))();
    udp.close();
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
    // ICE retries STUN at ~0.3s, 0.5s, 1s; wait long enough to catch one.
    await delay(1200);
    expect(neighbourHits).toBe(0);
    expect(neighbourUpgrades).toBe(0);
    expect(udpPackets).toBe(0);
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
