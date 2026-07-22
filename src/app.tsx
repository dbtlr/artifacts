import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { StreamableHTTPTransport } from '@hono/mcp';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';

import { HomePage } from './components/home-page.js';
import { Layout } from './components/layout.js';
import type { ArtifactStore } from './data/store.js';
import { getDefaultArtifactStore } from './data/store.js';
import { createMcpServer } from './mcp/server.js';

// Resolve the static asset root relative to this module, not process.cwd(),
// so a different WORKDIR/cwd (e.g. Docker) can't silently 404 every asset.
// Both the dev entry (src/app.tsx) and the packed bundle (dist/server.js)
// live exactly one directory below the repo root, so `../dist/public` reaches
// the Vite build output from either location. ARTIFACTS_STATIC_ROOT overrides
// it outright for deployments with a different layout.
const moduleDir = dirname(fileURLToPath(import.meta.url));
const STATIC_ROOT = process.env.ARTIFACTS_STATIC_ROOT ?? join(moduleDir, '..', 'dist', 'public');

// `store` is left undefined in production (`export const app` below), so the
// default sqlite-backed store is only ever touched lazily, on the first
// actual /mcp request — never merely by importing this module. Tests pass a
// temp-directory store explicitly instead of touching the repo's data/.
export function createApp(store?: ArtifactStore): Hono {
  const app = new Hono();
  const resolveStore = (): ArtifactStore => store ?? getDefaultArtifactStore();

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

  app.get('/', (c) =>
    c.html(
      <Layout title="Artifacts">
        <HomePage />
      </Layout>,
    ),
  );

  // Stateless MCP: no sessionIdGenerator, so a fresh McpServer + transport is
  // created per request and torn down once that request's response is ready.
  // enableJsonResponse makes handleRequest's returned promise wait for the
  // tool call to fully resolve (it resolves the response inline in `send`),
  // which is what makes closing the server safe immediately afterward —
  // without it, a POST's SSE response streams the result back after
  // handleRequest already returned, and closing here would abort it first.
  // GET (the optional standalone stream for server-initiated notifications,
  // which these stateless, push-free tools never use) is declined with 405 —
  // the client transport treats that as "no stream available" and moves on.
  app.all('/mcp', async (c) => {
    if (c.req.method === 'GET') {
      return c.body(null, 405);
    }
    const server = createMcpServer(resolveStore());
    const transport = new StreamableHTTPTransport({ enableJsonResponse: true });
    await server.connect(transport);
    try {
      return await transport.handleRequest(c);
    } finally {
      await server.close();
    }
  });

  return app;
}

export const app = createApp();
