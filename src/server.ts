import { setTimeout as delay } from 'node:timers/promises';

import { serve } from '@hono/node-server';

import { createApp } from './app.js';
import { assertNoLegacyEnv } from './legacy-env.js';
import { resolvePort } from './port.js';
import { getDefaultAppServices } from './services.js';
import { installNodeStaticFiles } from './static-files.js';
import { createPlaywrightRenderer, resolveChromiumPath } from './thumbnails/playwright-renderer.js';
import { resolvePublicBaseUrl } from './urls.js';

// How long shutdown waits for the headless browser to close before exiting
// anyway; well inside Docker's default 10s stop grace period.
const SHUTDOWN_GRACE_MS = 5_000;
// How often expired one-time secrets, upload slots, and claims are removed.
const SECRET_SWEEP_INTERVAL_MS = 10 * 60 * 1000;

assertNoLegacyEnv();
const port = resolvePort(process.env.MUNINN_PORT);
const services = await getDefaultAppServices();
const chromiumPath = await resolveChromiumPath(process.env);
const renderer = createPlaywrightRenderer({
  executablePath: chromiumPath,
  publicBaseUrl: resolvePublicBaseUrl(),
});
const app = createApp(services, undefined, installNodeStaticFiles);

// Previews are screenshots of this server's own pages, so rendering can
// only start once the port is bound. Backfill covers artifacts uploaded
// before previews existed (or whose preview files were lost). Any failure
// here is fatal, so this reports and exits rather than rejecting.
async function startThumbnails(boundPort: number): Promise<void> {
  try {
    services.thumbnailQueue.start(renderer, `http://127.0.0.1:${String(boundPort)}`);
    await services.thumbnailQueue.backfill(await services.artifacts.listArtifacts());
  } catch (error) {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`Muninn failed to start thumbnails: ${detail}\n`);
    process.exit(1);
  }
}

// Removes expired secret rows. A failed sweep is reported and retried at the
// next interval; the rows it missed stay unreadable, since every read checks
// expiry itself.
async function sweepSecrets(): Promise<void> {
  try {
    await services.secrets.sweep();
  } catch (error) {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`Muninn failed to sweep expired secrets: ${detail}\n`);
  }
}

void sweepSecrets();
setInterval(() => {
  void sweepSecrets();
}, SECRET_SWEEP_INTERVAL_MS).unref();

const server = serve({ fetch: app.fetch, port }, (info) => {
  process.stdout.write(`Muninn listening on http://localhost:${String(info.port)}\n`);
  void startThumbnails(info.port);
});

// The renderer opts out of Playwright's own signal handling (which would
// close the browser but leave this server running), so shutdown is owned
// here: stop accepting connections, give the browser a moment to close, exit.
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  process.stdout.write(`Muninn shutting down on ${signal}\n`);
  server.close();
  try {
    await Promise.race([renderer.close(), delay(SHUTDOWN_GRACE_MS)]);
  } catch {
    // A browser that failed to launch or died mid-close is no reason to
    // report an unclean exit.
  }
  process.exit(0);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void shutdown(signal);
  });
}
