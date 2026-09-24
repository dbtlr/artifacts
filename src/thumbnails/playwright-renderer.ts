import { access } from 'node:fs/promises';

import type { Browser } from 'playwright-core';
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

  async function launch(): Promise<Browser> {
    try {
      const launched = await chromium.launch({
        // The runtime container runs as an unprivileged user without the
        // kernel features Chromium's own sandbox wants; content is
        // self-authored on a trusted network, so the sandbox is not the
        // boundary here anyway.
        args: ['--no-sandbox', '--disable-dev-shm-usage'],
        ...(executablePath === undefined ? {} : { executablePath }),
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

  function currentBrowser(): Promise<Browser> {
    browser ??= launch();
    return browser;
  }

  async function render(target: ThumbnailTarget): Promise<Uint8Array | null> {
    // Headless Chromium downloads a PDF instead of drawing it.
    if (disabled || target.mediaType === 'application/pdf') {
      return null;
    }
    const context = await (
      await currentBrowser()
    ).newContext({
      colorScheme: 'dark',
      deviceScaleFactor: DEVICE_SCALE_FACTOR,
      viewport: VIEWPORT,
    });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(timeoutMs);
      if (mediaDefinition(target.mediaType).renderingMode === 'binary') {
        await page.setContent(imagePage(target.url), { waitUntil: 'networkidle' });
      } else {
        await page.goto(target.url, { waitUntil: 'networkidle' });
      }
      const shot = await page.screenshot({ quality: JPEG_QUALITY, type: 'jpeg' });
      return new Uint8Array(shot);
    } finally {
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
