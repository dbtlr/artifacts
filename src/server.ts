import { setTimeout as delay } from 'node:timers/promises';

import { serve } from '@hono/node-server';

import { createApp } from './app.js';
import { resolvePort } from './port.js';
import { getDefaultAppServices } from './services.js';
import { createPlaywrightRenderer, resolveChromiumPath } from './thumbnails/playwright-renderer.js';

// How long shutdown waits for the headless browser to close before exiting
// anyway; well inside Docker's default 10s stop grace period.
const SHUTDOWN_GRACE_MS = 5_000;

const port = resolvePort(process.env.ARTIFACTS_PORT);
const services = await getDefaultAppServices();
const chromiumPath = await resolveChromiumPath(process.env);
const renderer = createPlaywrightRenderer({ executablePath: chromiumPath });
const app = createApp(services);

const server = serve({ fetch: app.fetch, port }, (info) => {
  process.stdout.write(`Artifacts listening on http://localhost:${String(info.port)}\n`);
  // Previews are screenshots of this server's own pages, so rendering can
  // only start once the port is bound. Backfill covers artifacts uploaded
  // before previews existed (or whose preview files were lost).
  services.thumbnailQueue.start(renderer, `http://127.0.0.1:${String(info.port)}`);
  services.thumbnailQueue.backfill(services.artifacts.listArtifacts());
});

// The renderer opts out of Playwright's own signal handling (which would
// close the browser but leave this server running), so shutdown is owned
// here: stop accepting connections, give the browser a moment to close, exit.
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  process.stdout.write(`Artifacts shutting down on ${signal}\n`);
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
