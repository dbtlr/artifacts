import { serve } from '@hono/node-server';

import { createApp } from './app.js';
import { resolvePort } from './port.js';
import { getDefaultAppServices } from './services.js';
import { createPlaywrightRenderer, resolveChromiumPath } from './thumbnails/playwright-renderer.js';

const port = resolvePort(process.env.ARTIFACTS_PORT);
const services = await getDefaultAppServices();
const chromiumPath = await resolveChromiumPath(process.env);
const app = createApp(services);

serve({ fetch: app.fetch, port }, (info) => {
  process.stdout.write(`Artifacts listening on http://localhost:${String(info.port)}\n`);
  // Previews are screenshots of this server's own pages, so rendering can
  // only start once the port is bound. Backfill covers artifacts uploaded
  // before previews existed (or whose preview files were lost).
  services.thumbnailQueue.start(
    createPlaywrightRenderer({ executablePath: chromiumPath }),
    `http://127.0.0.1:${String(info.port)}`,
  );
  services.thumbnailQueue.backfill(services.artifacts.listArtifacts());
});
