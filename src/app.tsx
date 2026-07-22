import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { StreamableHTTPTransport } from '@hono/mcp';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';

import { ArtifactPage } from './components/artifact-page.js';
import { HomePage } from './components/home-page.js';
import { Layout } from './components/layout.js';
import { NotFoundPage } from './components/not-found-page.js';
import { ProjectPage } from './components/project-page.js';
import type { ArtifactStore } from './data/store.js';
import { getDefaultArtifactStore } from './data/store.js';
import { renderMarkdownToHtml } from './markdown.js';
import { createMcpServer } from './mcp/server.js';

// Resolve the static asset root relative to this module, not process.cwd(),
// so a different WORKDIR/cwd (e.g. Docker) can't silently 404 every asset.
// Both the dev entry (src/app.tsx) and the packed bundle (dist/server.js)
// live exactly one directory below the repo root, so `../dist/public` reaches
// the Vite build output from either location. ARTIFACTS_STATIC_ROOT overrides
// it outright for deployments with a different layout.
const moduleDir = dirname(fileURLToPath(import.meta.url));
const STATIC_ROOT = process.env.ARTIFACTS_STATIC_ROOT ?? join(moduleDir, '..', 'dist', 'public');

const MAX_MCP_BODY_BYTES = 10 * 1024 * 1024;

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

  app.get('/', (c) => {
    const artifacts = resolveStore().listArtifacts();
    return c.html(
      <Layout title="Artifacts">
        <HomePage artifacts={artifacts} />
      </Layout>,
    );
  });

  // Hono's c.req.param() already URL-decodes a segment that contains a `%`
  // (see hono/dist/request.js), so `project` here is the raw project name —
  // matching what ArtifactList encoded into the /p/:project link. A project
  // with zero artifacts (typo, or one that was never created) still renders
  // the ordinary list UI with an empty state — it's a filter, not a lookup,
  // so there's nothing 404-worthy about it coming back empty.
  app.get('/p/:project', (c) => {
    const project = c.req.param('project');
    const artifacts = resolveStore().listArtifacts({ project });
    return c.html(
      <Layout title={`${project} · Artifacts`}>
        <ProjectPage artifacts={artifacts} project={project} />
      </Layout>,
    );
  });

  // html artifacts are served as-is — CLAUDE.md: "HTML documents are
  // displayed as is" (same-origin script execution is an accepted risk,
  // since content is self-authored on a private network). md/txt render
  // inside the standard Layout instead. A row whose content file is missing
  // makes store.getArtifact throw (see store.ts) — that's deliberately left
  // unguarded here too, so it surfaces as a 500 rather than masquerading as
  // an ordinary 404.
  app.get('/a/:id', async (c) => {
    const id = c.req.param('id');
    const artifact = resolveStore().getArtifact(id);
    if (!artifact) {
      return c.html(
        <Layout title="Artifact not found">
          <NotFoundPage id={id} />
        </Layout>,
        404,
      );
    }
    if (artifact.type === 'html') {
      return c.html(artifact.content);
    }
    // Only `md` renders through the markdown pipeline; `txt` is passed
    // through untouched (ArtifactPage falls back to a plain <pre> whenever
    // renderedHtml is undefined).
    const renderedHtml =
      artifact.type === 'md' ? await renderMarkdownToHtml(artifact.content) : undefined;
    return c.html(
      <Layout title={artifact.title}>
        <ArtifactPage artifact={artifact} renderedHtml={renderedHtml} />
      </Layout>,
    );
  });

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
  // Cap request bodies: artifact content is agent-authored text; anything
  // beyond this is a mistake, not a use case.
  app.use('/mcp', bodyLimit({ maxSize: MAX_MCP_BODY_BYTES }));

  app.all('/mcp', async (c) => {
    if (c.req.method === 'GET') {
      return c.body(null, 405, { Allow: 'POST' });
    }
    const server = createMcpServer(resolveStore());
    const transport = new StreamableHTTPTransport({ enableJsonResponse: true });
    try {
      await server.connect(transport);
      return await transport.handleRequest(c);
    } finally {
      await server.close();
    }
  });

  return app;
}

export const app = createApp();
