import { createHash } from 'node:crypto';

import { StreamableHTTPTransport } from '@hono/mcp';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';

import { substituteEmbedReferences } from './artifacts/embeds.js';
import { adaptLegacyArtifactStore } from './artifacts/legacy-adapter.js';
import { legacyTypeFromMediaType } from './artifacts/media.js';
import type {
  ArtifactService,
  ArtifactStore,
  ArtifactWithContent,
  LegacyArtifactWithContent,
} from './artifacts/types.js';
import { installOwnerAuth } from './auth/routes.js';
import { EMBED_URL_EXPIRY } from './auth/signed-urls.js';
import { ArtifactPage } from './components/artifact-page.js';
import { HomePage } from './components/home-page.js';
import { Layout } from './components/layout.js';
import { NotFoundPage } from './components/not-found-page.js';
import { ProjectPage } from './components/project-page.js';
import { buildIndexView, kindOf } from './index-view.js';
import { createMcpServer } from './mcp/server.js';
import { installSecretNoStore, installSecretRoutes } from './secrets/routes.js';
import type { AppServices } from './services.js';
import { placeholderSvg } from './thumbnails/placeholder.js';
import { isOwnOrigin } from './urls.js';

const MAX_MCP_BODY_BYTES = 16 * 1024 * 1024;

// HTML artifacts run their scripts in an opaque origin: without
// allow-same-origin they cannot read the app's cookies, storage, or
// responses, and without allow-forms they cannot submit forms to it. Their
// requests carry `Origin: null`, which /mcp refuses (see the /mcp route).
// They may open new windows, which load as ordinary pages outside the
// sandbox, and show alert, confirm, and prompt dialogs. See ADR-0006.
const HTML_ARTIFACT_CSP =
  'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-modals';

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

function suppliedServices(
  store: ArtifactStore | AppServices,
  mcpService: ArtifactService | undefined,
): AppServices {
  if ('artifacts' in store) {
    return store;
  }
  const artifacts = adaptLegacyArtifactStore(store);
  return { artifacts, mcp: mcpService ?? artifacts };
}

// Installs the static-file routes on the app, ahead of auth, so they are served
// before any session check; auth lists the same paths as public. The Node
// implementation is in static-files.ts; a runtime without one supplies none,
// and those routes fall through to the 404 page.
export type StaticFileInstaller = (app: Hono) => void;

export function createApp(
  store: ArtifactStore | AppServices,
  mcpService?: ArtifactService,
  installStaticFiles?: StaticFileInstaller,
): Hono {
  const app = new Hono();
  // A supplied legacy store is adapted once, when the app is built.
  const supplied = suppliedServices(store, mcpService);
  const resolveServices = (): Promise<AppServices> => Promise.resolve(supplied);

  installStaticFiles?.(app);

  // Secret responses are never cached, owner-auth refusals included.
  installSecretNoStore(app);

  // With an owner password configured, every route below needs a session.
  installOwnerAuth(app, async () => (await resolveServices()).auth);

  installSecretRoutes(app, async () => (await resolveServices()).secrets);

  // `?kind=html` narrows either gallery to one file kind; an unknown kind is
  // ignored rather than 404ed, for the same reason an unknown project is.
  app.get('/', async (c) => {
    const services = await resolveServices();
    const artifacts = await services.artifacts.listArtifacts();
    const view = buildIndexView(artifacts, { kind: c.req.query('kind') });
    return c.html(
      <Layout title="Muninn" wide>
        <HomePage view={view} showLogOut={services.auth !== undefined} />
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
    // One read serves both the project-scoped view and the header's project
    // selector, which offers every project. The store's own project filter
    // is exact equality, so filtering here matches it.
    const services = await resolveServices();
    const all = await services.artifacts.listArtifacts();
    const { projects } = buildIndexView(all, {});
    const view = buildIndexView(
      all.filter((artifact) => artifact.project === project),
      { kind: c.req.query('kind') },
    );
    return c.html(
      <Layout title={`${project} · Muninn`} wide>
        <ProjectPage
          project={project}
          projects={projects}
          showLogOut={services.auth !== undefined}
          view={view}
        />
      </Layout>,
    );
  });

  // The gallery card's <img>: the rendered JPEG when one exists, otherwise a
  // drawn per-kind placeholder. Both are `no-cache` so a browser revalidates
  // and picks up the real image once it lands; the JPEG carries an ETag so
  // that revalidation is a 304 while the stored preview is unchanged.
  app.get('/a/:id/thumb', async (c) => {
    const services = await resolveServices();
    const id = c.req.param('id');
    const artifact = await services.artifacts.findArtifact(id);
    if (!artifact) {
      return c.body(null, 404);
    }
    const bytes = services.thumbnails === undefined ? null : await services.thumbnails.read(id);
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

  // html artifacts are served as-is, inside the HTML_ARTIFACT_CSP sandbox.
  // With owner auth on, the sandbox's own requests carry no session, so each
  // embedded /a/:id URL its template records is signed for this view; a
  // request that got here was already allowed to read the page, by session
  // or by signature. md/txt render inside the standard Layout instead, md
  // from its stored rendering, whose embeds are signed the same way: a frame
  // in a sandboxed page and the preview renderer read it with no session. A
  // row whose content file is missing makes getArtifact reject (see
  // artifacts/service.ts) — that's deliberately left unguarded here too, so
  // it surfaces as a 500 rather than masquerading as an ordinary 404. An md view reads its content only when the rendering
  // must be made again.
  app.on(['GET', 'HEAD'], '/a/:id', async (c) => {
    const id = c.req.param('id');
    const { artifacts, auth } = await resolveServices();
    // With owner auth on, each /a/:id URL that this artifact's template
    // records in `html` is replaced with one signed for this view.
    const signEmbeds = async (html: string): Promise<string> =>
      auth === undefined
        ? html
        : substituteEmbedReferences(
            html,
            (await artifacts.getEmbedReferences(id)) ?? [],
            (embedded) => auth.artifactUrls.signedPath(embedded, EMBED_URL_EXPIRY),
          );
    const notFound = () =>
      c.html(
        <Layout title="Artifact not found">
          <NotFoundPage id={id} />
        </Layout>,
        404,
      );
    const found = await artifacts.findArtifact(id);
    if (!found) {
      return notFound();
    }
    // Markdown is served from its stored rendering: no parsing, and no read
    // of the content bytes. Null here means it was removed meanwhile.
    if (found.mediaType === 'text/markdown') {
      const rendered = await artifacts.getRenderedMarkdown(id);
      if (rendered === null) {
        return notFound();
      }
      const html = await signEmbeds(rendered.html);
      return c.html(
        <Layout title={found.title}>
          <ArtifactPage artifact={found} rendered={{ ...rendered, html }} />
        </Layout>,
      );
    }
    const artifact = await artifacts.getArtifact(id);
    if (!artifact) {
      return notFound();
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
      const html = await signEmbeds(legacy.content);
      return c.html(html, 200, { 'Content-Security-Policy': HTML_ARTIFACT_CSP });
    }
    return c.html(
      <Layout title={legacy.title}>
        <ArtifactPage artifact={legacy} text={legacy.content} />
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
    // Any web page, and any sandboxed HTML artifact (whose requests carry
    // `Origin: null`), can POST here without a CORS preflight: a text/plain
    // content type that mentions application/json passes the transport's
    // check. MCP clients send no Origin, so a request from any origin but this
    // server's is refused, to keep pages and artifact scripts from creating
    // or removing artifacts when no owner password is set.
    const origin = c.req.header('Origin');
    if (origin !== undefined && !isOwnOrigin(origin, c.req.url)) {
      return c.body(null, 403);
    }
    if (c.req.method === 'GET') {
      return c.body(null, 405, { Allow: 'POST' });
    }
    const services = await resolveServices();
    const server = createMcpServer(services.mcp, services.secrets);
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
