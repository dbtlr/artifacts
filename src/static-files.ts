import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { serveStatic } from '@hono/node-server/serve-static';
import type { Hono } from 'hono';

// Resolve the static asset root relative to this module, not process.cwd(),
// so a different WORKDIR/cwd (e.g. Docker) can't silently 404 every asset.
// Both the dev entry (src/static-files.ts) and the packed bundle
// (dist/server.js) live exactly one directory below the repo root, so
// `../dist/public` reaches the Vite build output from either location.
// MUNINN_STATIC_ROOT overrides it outright for deployments with a different
// layout.
const moduleDir = dirname(fileURLToPath(import.meta.url));
const STATIC_ROOT = process.env.MUNINN_STATIC_ROOT ?? join(moduleDir, '..', 'dist', 'public');

// Node's static-file routes, passed to createApp by server.ts.
export function installNodeStaticFiles(app: Hono): void {
  // Namespaced under /assets so dynamic routes (/mcp, /a/:id) can never be
  // shadowed by an asset filename or race a filesystem stat. serveStatic
  // calls next() on a miss, so this falls through to the route handlers below.
  app.use(
    '/assets/*',
    serveStatic({
      rewriteRequestPath: (path) => path.replace(/^\/assets/u, ''),
      root: STATIC_ROOT,
    }),
  );

  // Root-level icon endpoints, serving real bytes rather than redirecting:
  // raw html artifacts render without the Layout head, so browsers and
  // tab-icon probes (t3code among them) fall back to these well-known root
  // paths, and naive probes don't follow redirects. /favicon.ico gets the
  // 32px PNG's bytes with an image/png content type — modern clients sniff
  // the content and none of them require a real ICO container.
  app.use('/favicon.svg', serveStatic({ path: 'favicon.svg', root: STATIC_ROOT }));
  app.use('/favicon.ico', serveStatic({ path: 'favicon-32.png', root: STATIC_ROOT }));
  app.use(
    '/apple-touch-icon.png',
    serveStatic({ path: 'apple-touch-icon.png', root: STATIC_ROOT }),
  );
}
