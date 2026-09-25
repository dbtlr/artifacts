import { access } from 'node:fs/promises';

import type { Browser, BrowserContext } from 'playwright-core';
import { chromium } from 'playwright-core';

import { mediaDefinition } from '../artifacts/media.js';
import type { ThumbnailRenderer, ThumbnailTarget } from './types.js';

// Rendered at a desktop width, then captured at half scale: the gallery
// shows a card a few hundred pixels wide, so 640x400 is plenty and keeps
// each JPEG a few tens of kilobytes.
const VIEWPORT = { height: 800, width: 1280 };
const DEVICE_SCALE_FACTOR = 0.5;
const JPEG_QUALITY = 80;

// Where a Chromium may already be, when ARTIFACTS_CHROMIUM_PATH is not set:
// the Alpine `chromium` package (the Docker image), common Linux desktops,
// and macOS. Any hit is fine; playwright-core drives it over CDP.
const CHROMIUM_CANDIDATES = [
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function resolveChromiumPath(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const override = env.ARTIFACTS_CHROMIUM_PATH?.trim();
  if (override !== undefined && override !== '') {
    return override;
  }
  const found = await Promise.all(CHROMIUM_CANDIDATES.map(exists));
  return CHROMIUM_CANDIDATES.find((_, index) => found[index]);
}

type RendererOptions = {
  executablePath?: string | undefined;
  report?: (message: string) => void;
  // Upper bound for one whole render, from opening the page to the
  // screenshot; a page that is still busy at the deadline is closed and the
  // render fails.
  timeoutMs?: number;
};

function defaultReport(message: string): void {
  process.stderr.write(`${message}\n`);
}

// Images get a tiny wrapper page rather than Chromium's bare image viewer, so
// the preview is the picture fitted on black instead of a corner of it.
function imagePage(url: string): string {
  return (
    '<!doctype html><html><body style="margin:0;background:#000;display:grid;place-items:center;height:100vh">' +
    `<img src="${url}" alt="" style="max-width:100%;max-height:100%;object-fit:contain"></body></html>`
  );
}

// The render context may only GET from this server's own origin. An artifact's
// scripts already run same-origin in a trusted viewer's browser, but a page
// rendered here runs on the server host with nobody watching: without a
// fence it could screenshot loopback or container-network neighbours into a
// public thumbnail, or POST to /mcp and re-trigger its own render forever.
//
// The fence has two layers. The browser is launched (see `launch`) with a
// proxy nobody listens on and a bypass list naming only the server's own
// host and port, so every other connection the network stack makes, from
// any page, frame, or worker, including WebSocket upgrades, dies at the
// proxy. This request filter then narrows the one allowed origin to GETs,
// which keeps /mcp out of reach. (Playwright's routeWebSocket is a page-JS
// mock that workers never see, so it is no substitute for the proxy.)
async function confineToOrigin(context: BrowserContext, origin: string): Promise<void> {
  await context.route('**/*', (route) => {
    const request = route.request();
    const allowed = request.method() === 'GET' && new URL(request.url()).origin === origin;
    return allowed ? route.continue() : route.abort('blockedbyclient');
  });
  await context.addInitScript(removeWebRtc);
}

// TCP port 9 (discard) on loopback: nothing listens there, so proxied
// connections are refused at once rather than hanging.
const DEAD_PROXY = 'http://127.0.0.1:9';

export function proxyFencedTo(origin: string): { bypass: string; server: string } {
  // `<-loopback>` removes Chromium's implicit "never proxy loopback" rule,
  // so 127.0.0.1 on any other port goes to the dead proxy like everything
  // else; the one host:port bypass is this server. The port is always
  // spelled out: URL.host drops a default port, and a bare hostname in a
  // bypass rule matches every port on it.
  const url = new URL(origin);
  const defaultPort = url.protocol === 'https:' ? '443' : '80';
  const port = url.port === '' ? defaultPort : url.port;
  return { bypass: `<-loopback>,${url.hostname}:${port}`, server: DEAD_PROXY };
}

// WebRTC talks UDP to STUN/TURN servers and resolves their hostnames on its
// own, past both the proxy and the request filter, so it is removed from
// every document the render context creates. It exists on windows only,
// never in workers, so the init script covers it fully.
function removeWebRtc(): void {
  for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCIceTransport']) {
    Reflect.deleteProperty(globalThis, name);
  }
}

async function closeQuietly(context: BrowserContext): Promise<void> {
  try {
    await context.close();
  } catch {
    // Already closed by the render's own finally; nothing to do.
  }
}

// One shared headless Chromium, launched on first use and relaunched after a
// crash. Each render gets its own short-lived context, so nothing leaks from
// one artifact's scripts into the next. A launch that fails (no Chromium on
// this machine) is reported once; after that every render declines with
// null and the gallery keeps its drawn placeholders.
export function createPlaywrightRenderer({
  executablePath,
  report = defaultReport,
  timeoutMs = 15_000,
}: RendererOptions = {}): ThumbnailRenderer {
  let browser: Promise<Browser> | undefined;
  let disabled = false;
  // The proxy fence is a launch option, so the browser is pinned to the
  // first origin it renders; every artifact URL comes from the same
  // server, so a second origin is a caller bug, not a case to support.
  let pinnedOrigin: string | undefined;

  async function launch(origin: string): Promise<Browser> {
    try {
      const launched = await chromium.launch({
        args: [
          // The runtime container runs as an unprivileged user without the
          // kernel features Chromium's own sandbox wants; content is
          // self-authored on a trusted network, so the sandbox is not the
          // boundary here anyway.
          '--no-sandbox',
          '--disable-dev-shm-usage',
        ],
        proxy: proxyFencedTo(origin),
        ...(executablePath === undefined ? {} : { executablePath }),
        // Playwright's own signal handlers close the browser but swallow the
        // signal, which would leave the HTTP server running through a
        // `docker stop`. server.ts owns shutdown and calls close().
        handleSIGHUP: false,
        handleSIGINT: false,
        handleSIGTERM: false,
      });
      launched.on('disconnected', () => {
        browser = undefined;
      });
      return launched;
    } catch (error) {
      browser = undefined;
      disabled = true;
      const message = error instanceof Error ? error.message : String(error);
      report(`Thumbnail rendering disabled, Chromium failed to launch: ${message}`);
      throw error;
    }
  }

  async function currentBrowser(origin: string): Promise<Browser | null> {
    pinnedOrigin ??= origin;
    if (origin !== pinnedOrigin) {
      throw new Error(`Thumbnail renderer is pinned to ${pinnedOrigin}, cannot render ${origin}`);
    }
    try {
      browser ??= launch(origin);
      return await browser;
    } catch {
      // Already reported by launch(); the caller declines quietly.
      return null;
    }
  }

  async function capture(context: BrowserContext, target: ThumbnailTarget): Promise<Uint8Array> {
    const page = await context.newPage();
    page.setDefaultTimeout(timeoutMs);
    if (mediaDefinition(target.mediaType).renderingMode === 'binary') {
      await page.setContent(imagePage(target.url), { waitUntil: 'networkidle' });
    } else {
      await page.goto(target.url, { waitUntil: 'networkidle' });
    }
    const shot = await page.screenshot({ quality: JPEG_QUALITY, type: 'jpeg' });
    return new Uint8Array(shot);
  }

  async function render(target: ThumbnailTarget): Promise<Uint8Array | null> {
    // Headless Chromium downloads a PDF instead of drawing it.
    if (disabled || target.mediaType === 'application/pdf') {
      return null;
    }
    const origin = new URL(target.url).origin;
    const launched = await currentBrowser(origin);
    if (launched === null) {
      return null;
    }
    const context = await launched.newContext({
      acceptDownloads: false,
      colorScheme: 'dark',
      deviceScaleFactor: DEVICE_SCALE_FACTOR,
      viewport: VIEWPORT,
    });
    // One deadline for the whole render: closing the context makes whatever
    // step is in flight reject, so a page that keeps the network busy and
    // then spins cannot hold the queue past timeoutMs.
    const deadline = setTimeout(() => {
      void closeQuietly(context);
    }, timeoutMs);
    try {
      await confineToOrigin(context, origin);
      return await capture(context, target);
    } finally {
      clearTimeout(deadline);
      await context.close();
    }
  }

  return {
    close: async () => {
      if (browser !== undefined) {
        await (await browser).close();
      }
    },
    render,
  };
}
