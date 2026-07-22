import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';

import { HomePage } from './components/home-page.js';
import { Layout } from './components/layout.js';

// Resolve the static asset root relative to this module, not process.cwd(),
// so a different WORKDIR/cwd (e.g. Docker) can't silently 404 every asset.
// Both the dev entry (src/app.tsx) and the packed bundle (dist/server.js)
// live exactly one directory below the repo root, so `../dist/public` reaches
// the Vite build output from either location. ARTIFACTS_STATIC_ROOT overrides
// it outright for deployments with a different layout.
const moduleDir = dirname(fileURLToPath(import.meta.url));
const STATIC_ROOT = process.env.ARTIFACTS_STATIC_ROOT ?? join(moduleDir, '..', 'dist', 'public');

const app = new Hono();

// Namespaced under /assets so future dynamic routes (/mcp, /a/:id) can never
// be shadowed by an asset filename or race a filesystem stat. serveStatic
// calls next() on a miss, so this falls through to the route handlers below.
app.use(
  '/assets/*',
  serveStatic({
    rewriteRequestPath: (path) => path.replace(/^\/assets/u, ''),
    root: STATIC_ROOT,
  }),
);

app.get('/', (c) =>
  c.html(
    <Layout title="Artifacts">
      <HomePage />
    </Layout>,
  ),
);

export { app };
