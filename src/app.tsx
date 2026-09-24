import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { StreamableHTTPTransport } from '@hono/mcp';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';

import { legacyTypeFromMediaType } from './artifacts/media.js';
import { ArtifactPage } from './components/artifact-page.js';
import { HomePage } from './components/home-page.js';
import { Layout } from './components/layout.js';
import { NotFoundPage } from './components/not-found-page.js';
import { ProjectPage } from './components/project-page.js';
import type {
  ArtifactService,
  ArtifactStore,
  ArtifactWithContent,
  LegacyArtifactWithContent,
} from './data/store.js';
import { adaptLegacyArtifactStore } from './data/store.js';
import { buildIndexView, kindOf } from './index-view.js';
import { renderMarkdownToHtml } from './markdown.js';
import { createMcpServer } from './mcp/server.js';
import type { AppServices } from './services.js';
import { getDefaultAppServices } from './services.js';
import { placeholderSvg } from './thumbnails/placeholder.js';

// Resolve the static asset root relative to this module, not process.cwd(),
// so a different WORKDIR/cwd (e.g. Docker) can't silently 404 every asset.
// Both the dev entry (src/app.tsx) and the packed bundle (dist/server.js)
// live exactly one directory below the repo root, so `../dist/public` reaches
// the Vite build output from either location. ARTIFACTS_STATIC_ROOT overrides
// it outright for deployments with a different layout.
const moduleDir = dirname(fileURLToPath(import.meta.url));
const STATIC_ROOT = process.env.ARTIFACTS_STATIC_ROOT ?? join(moduleDir, '..', 'dist', 'public');

const MAX_MCP_BODY_BYTES = 16 * 1024 * 1024;

// `store` is left undefined in production (`export const app` below), so the
// default sqlite-backed services (see services.ts) are only ever touched
// lazily, on the first actual request — never merely by importing this
// module. Tests pass temp-directory services explicitly instead of touching
// the repo's data/.
async function defaultServices(mcpService?: ArtifactService): Promise<AppServices> {
  const services = await getDefaultAppServices();
  return mcpService === undefined ? services : { ...services, mcp: mcpService };
}

function etagOf(bytes: Uint8Array): string {
  return `"${createHash('sha256').update(bytes).digest('base64url')}"`;
}

function matchesIfNoneMatch(header: string | undefined, etag: string): boolean {
  if (header === undefined) {
    return false;
  }
  return header.split(',').some((candidate) => {
    const value = candidate.trim();
    return value === '*' || value === etag || value.replace(/^W\//u, '') === etag;
  });
}

function contentDisposition(filename: string): string {
  const quoted = filename.replaceAll(/[^\x20-\x7e]/gu, '_').replaceAll('"', String.raw`\"`);
  const encoded = encodeURIComponent(filename).replaceAll(
    /['()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `inline; filename="${quoted}"; filename*=UTF-8''${encoded}`;
}

function legacyArtifact(artifact: ArtifactWithContent): LegacyArtifactWithContent {
  const type = legacyTypeFromMediaType(artifact.mediaType);
  if (type === undefined) {
    throw new Error(`Unsupported text media type ${artifact.mediaType}`);
  }
  const {
    collection: _collection,
    filename: _filename,
    mediaType: _mediaType,
    ...fields
  } = artifact;
  return {
    ...fields,
    content: new TextDecoder('utf-8', { fatal: true }).decode(artifact.content),
    type,
  };
}

export function createApp(store?: ArtifactStore | AppServices, mcpService?: ArtifactService): Hono {
  const app = new Hono();
  const resolveServices = (): Promise<AppServices> => {
    if (store === undefined) {
      return defaultServices(mcpService);
    }
    if ('artifacts' in store) {
      return Promise.resolve(store);
    }
    const artifacts = adaptLegacyArtifactStore(store);
    return Promise.resolve({ artifacts, mcp: mcpService ?? artifacts });
  };

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

  // `?kind=html` narrows either gallery to one file kind; an unknown kind is
  // ignored rather than 404ed, for the same reason an unknown project is.
  app.get('/', async (c) => {
    const artifacts = (await resolveServices()).artifacts.listArtifacts();
    const view = buildIndexView(artifacts, { kind: c.req.query('kind') });
    return c.html(
      <Layout title="Artifacts" wide>
        <HomePage view={view} />
      </Layout>,
    );
  });

  // Hono's c.req.param() already URL-decodes a segment that contains a `%`
  // (see hono/dist/request.js), so `project` here is the raw project name —
  // matching what the gallery encoded into the /p/:project link. A project
  // with zero artifacts (typo, or one that was never created) still renders
  // the ordinary gallery UI with an empty state — it's a filter, not a
  // lookup, so there's nothing 404-worthy about it coming back empty.
  app.get('/p/:project', async (c) => {
    const project = c.req.param('project');
    const artifacts = (await resolveServices()).artifacts.listArtifacts({ project });
    const view = buildIndexView(artifacts, { kind: c.req.query('kind') });
    return c.html(
      <Layout title={`${project} · Artifacts`} wide>
        <ProjectPage project={project} view={view} />
      </Layout>,
    );
  });

  // The gallery card's <img>: the rendered JPEG when one exists, otherwise a
  // drawn per-kind placeholder. Both are `no-cache` so a browser revalidates
  // and picks up the real image once it lands; the JPEG carries an ETag so
  // that revalidation is a 304 until the artifact is re-rendered.
  app.get('/a/:id/thumb', async (c) => {
    const services = await resolveServices();
    const id = c.req.param('id');
    const artifact = services.artifacts.findArtifact(id);
    if (!artifact) {
      return c.body(null, 404);
    }
    const bytes = services.thumbnails?.read(id) ?? null;
    if (bytes === null) {
      return c.body(placeholderSvg(kindOf(artifact.mediaType)), 200, {
        'Cache-Control': 'no-cache',
        'Content-Type': 'image/svg+xml; charset=utf-8',
      });
    }
    const etag = etagOf(bytes);
    const headers = { 'Cache-Control': 'no-cache', 'Content-Type': 'image/jpeg', ETag: etag };
    if (matchesIfNoneMatch(c.req.header('If-None-Match'), etag)) {
      return c.body(null, 304, headers);
    }
    return new Response(new Uint8Array(bytes).buffer, { headers, status: 200 });
  });

  // html artifacts are served as-is — CLAUDE.md: "HTML documents are
  // displayed as is" (same-origin script execution is an accepted risk,
  // since content is self-authored on a private network). md/txt render
  // inside the standard Layout instead. A row whose content file is missing
  // makes store.getArtifact throw (see store.ts) — that's deliberately left
  // unguarded here too, so it surfaces as a 500 rather than masquerading as
  // an ordinary 404.
  app.on(['GET', 'HEAD'], '/a/:id', async (c) => {
    const id = c.req.param('id');
    const artifact = (await resolveServices()).artifacts.getArtifact(id);
    if (!artifact) {
      return c.html(
        <Layout title="Artifact not found">
          <NotFoundPage id={id} />
        </Layout>,
        404,
      );
    }
    const renderingMode = legacyTypeFromMediaType(artifact.mediaType);
    if (renderingMode === undefined) {
      const etag = etagOf(artifact.content);
      const headers: Record<string, string> = {
        'Cache-Control': 'no-cache',
        'Content-Disposition': contentDisposition(artifact.filename!),
        'Content-Length': String(artifact.content.byteLength),
        'Content-Type': artifact.mediaType,
        ETag: etag,
        'X-Content-Type-Options': 'nosniff',
      };
      if (artifact.mediaType === 'image/svg+xml') {
        headers['Content-Security-Policy'] =
          "default-src 'none'; style-src 'unsafe-inline'; sandbox";
      }
      if (matchesIfNoneMatch(c.req.header('If-None-Match'), etag)) {
        return c.body(null, 304, headers);
      }
      return new Response(
        c.req.method === 'HEAD' ? null : new Uint8Array(artifact.content).buffer,
        {
          headers,
          status: 200,
        },
      );
    }
    const legacy = legacyArtifact(artifact);
    if (legacy.type === 'html') {
      return c.html(legacy.content);
    }
    // Only `md` renders through the markdown pipeline; `txt` is passed
    // through untouched (ArtifactPage falls back to a plain <pre> whenever
    // `rendered` is undefined).
    const rendered = legacy.type === 'md' ? await renderMarkdownToHtml(legacy.content) : undefined;
    return c.html(
      <Layout title={legacy.title}>
        <ArtifactPage artifact={legacy} rendered={rendered} />
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
    const server = createMcpServer((await resolveServices()).mcp);
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
