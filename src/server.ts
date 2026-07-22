import { serve } from '@hono/node-server';

import { app } from './app.js';

const DEFAULT_PORT = 3000;
const port = Number.parseInt(process.env.PORT ?? '', 10) || DEFAULT_PORT;

serve({ fetch: app.fetch, port }, (info) => {
  process.stdout.write(`Artifacts listening on http://localhost:${String(info.port)}\n`);
});
