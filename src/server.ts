import { serve } from '@hono/node-server';

import { app } from './app.js';
import { resolvePort } from './port.js';

const port = resolvePort(process.env.PORT);

serve({ fetch: app.fetch, port }, (info) => {
  process.stdout.write(`Artifacts listening on http://localhost:${String(info.port)}\n`);
});
