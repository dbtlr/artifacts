import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { CookieOptions } from 'hono/utils/cookie';

import { ApiKeysPage } from '../components/api-keys-page.js';
import { Layout } from '../components/layout.js';
import { LoginPage } from '../components/login-page.js';
import { isOwnOrigin, resolvePublicBaseUrl } from '../urls.js';
import { SESSION_LIFETIME_SECONDS } from './owner-auth.js';
import type { OwnerAuth } from './owner-auth.js';

export const SESSION_COOKIE = 'artifacts_session';

const MAX_FORM_BODY_BYTES = 16 * 1024;
const MAX_API_KEY_NAME_LENGTH = 100;
const SAFE_METHODS = new Set(['GET', 'HEAD']);
// Served without a session: the login form and the static files it uses.
const ICON_PATHS = new Set(['/apple-touch-icon.png', '/favicon.ico', '/favicon.svg']);

function isPublicPath(path: string): boolean {
  return path === '/login' || path.startsWith('/assets/') || ICON_PATHS.has(path);
}

// A path that browsers read as this server: one slash, then not `/` or `\`
// (`//host` and `/\host` name another host).
const LOCAL_PATH = /^\/(?![/\\])/u;

// Where a login may send the browser afterwards: a path on this server only.
// Anything else falls back to the home page. The normalized result is checked
// too, because resolving dot segments turns `/.//host` into `//host`.
export function safeNextPath(value: unknown): string {
  if (typeof value !== 'string' || !LOCAL_PATH.test(value)) {
    return '/';
  }
  const base = 'http://artifacts.invalid';
  const url = new URL(value, base);
  const path = `${url.pathname}${url.search}`;
  return url.origin === base && LOCAL_PATH.test(path) ? path : '/';
}

// A state-changing request must name its origin, and that origin must be
// this server as the request reached it or as its public base URL names it
// (they differ behind a proxy). Browsers send Origin on every POST, so a
// missing one means a non-browser client or an old browser, and `null`
// means a sandboxed artifact or a privacy redirect; all are refused.
function hasAllowedOrigin(c: Context): boolean {
  const origin = c.req.header('Origin');
  return origin !== undefined && isOwnOrigin(origin, c.req.url);
}

function cookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    path: '/',
    sameSite: 'Lax',
    secure: resolvePublicBaseUrl().startsWith('https:'),
  };
}

// Pages for one owner must not be kept by a shared cache. An existing
// directive such as `no-cache` stays, so ETag revalidation still works.
function markPrivate(res: Response): void {
  const cacheControl = res.headers.get('Cache-Control');
  res.headers.set(
    'Cache-Control',
    cacheControl === null ? 'private, no-cache' : `private, ${cacheControl}`,
  );
}

// App pages refuse every frame. A same-site page on another port or a
// sibling subdomain gets the SameSite=Lax cookie, so it could otherwise frame
// the key or logout forms and steer the owner's clicks. Artifacts under /a/
// stay frameable, because sandboxed HTML artifacts embed them.
function denyFraming(path: string, res: Response): void {
  if (!path.startsWith('/a/')) {
    res.headers.set('Content-Security-Policy', "frame-ancestors 'none'");
    res.headers.set('X-Frame-Options', 'DENY');
  }
}

function markOwnerResponse(path: string, res: Response): void {
  markPrivate(res);
  denyFraming(path, res);
}

function loginPage(c: Context, next: string, status: 200 | 401 | 429, error?: string) {
  return c.html(
    <Layout title="Log in · Artifacts">
      <LoginPage error={error} next={next} />
    </Layout>,
    status,
  );
}

// The token from an `Authorization: Bearer <token>` header. The scheme is
// case-insensitive (RFC 9110); anything else yields undefined.
function bearerToken(header: string | undefined): string | undefined {
  return header === undefined ? undefined : /^Bearer +(\S+) *$/iu.exec(header)?.[1];
}

async function apiKeysPage(
  c: Context,
  auth: OwnerAuth,
  props: { created?: { key: string; name: string }; error?: string; status?: 200 | 400 },
) {
  return c.html(
    <Layout title="API keys · Artifacts">
      <ApiKeysPage
        created={props.created}
        error={props.error}
        keys={await auth.listApiKeys()}
        mcpUrl={`${resolvePublicBaseUrl()}/mcp`}
      />
    </Layout>,
    props.status ?? 200,
  );
}

// Signed URLs read one artifact: GET or HEAD of `/a/:id` only.
const SIGNED_READ_PATH = /^\/a\/([^/]+)$/u;

// Whether the request carries a signature from `auth` for what it asks for.
// A signature on any other method or path grants nothing.
function hasValidSignature(c: Context, auth: OwnerAuth): boolean {
  const id = SIGNED_READ_PATH.exec(c.req.path)?.[1];
  return (
    SAFE_METHODS.has(c.req.method) &&
    id !== undefined &&
    auth.artifactUrls.verify(id, new URL(c.req.url).searchParams)
  );
}

// The response for a request that auth on does not let through, or
// undefined when it may proceed.
async function refuseWithoutSession(c: Context, auth: OwnerAuth): Promise<Response | undefined> {
  // Decide on the percent-decoded path that routing uses, so `/%6dcp` is /mcp.
  const path = c.req.path;
  // MCP clients cannot hold a session cookie, so /mcp takes an API key
  // instead, and only an API key. A browser cannot attach the header to a
  // cross-site request without a CORS preflight, which this server never
  // grants, so the Origin rule below is not needed here.
  if (path === '/mcp') {
    return (await auth.hasApiKey(bearerToken(c.req.header('Authorization'))))
      ? undefined
      : c.text('Unauthorized: /mcp needs Authorization: Bearer <API key>', 401, {
          'WWW-Authenticate': 'Bearer',
        });
  }
  if (!SAFE_METHODS.has(c.req.method) && !hasAllowedOrigin(c)) {
    return c.text('Forbidden', 403);
  }
  if (isPublicPath(path) || (await auth.hasSession(getCookie(c, SESSION_COOKIE)))) {
    return undefined;
  }
  // A request that carries a signature is judged by it rather than sent to
  // the login form: its reader is a renderer, not a person who can log in.
  if (new URL(c.req.url).searchParams.has('signature')) {
    return hasValidSignature(c, auth) ? undefined : c.text('Forbidden', 403);
  }
  if (SAFE_METHODS.has(c.req.method)) {
    const url = new URL(c.req.url);
    return c.redirect(`/login?next=${encodeURIComponent(`${url.pathname}${url.search}`)}`);
  }
  return c.text('Unauthorized', 401);
}

// Owner auth over HTTP. `resolveAuth` resolves undefined when no owner
// password is configured; then every route here is a 404 and the guard lets
// every request through untouched, which is the no-auth behavior. Install it
// after the static asset middleware and before every other route.
export function installOwnerAuth(
  app: Hono,
  resolveAuth: () => Promise<OwnerAuth | undefined>,
): void {
  app.use('*', async (c, next) => {
    const auth = await resolveAuth();
    if (auth === undefined) {
      return next();
    }
    const refusal = await refuseWithoutSession(c, auth);
    if (refusal !== undefined) {
      return refusal;
    }
    // Mark the response once the route has produced it.
    return next().then(() => markOwnerResponse(c.req.path, c.res));
  });

  app.get('/login', async (c) => {
    const auth = await resolveAuth();
    if (auth === undefined) {
      return c.notFound();
    }
    const next = safeNextPath(c.req.query('next'));
    if (await auth.hasSession(getCookie(c, SESSION_COOKIE))) {
      return c.redirect(next);
    }
    return loginPage(c, next, 200);
  });

  app.post('/login', bodyLimit({ maxSize: MAX_FORM_BODY_BYTES }), async (c) => {
    const auth = await resolveAuth();
    if (auth === undefined) {
      return c.notFound();
    }
    const form = await c.req.parseBody();
    const next = safeNextPath(form.next);
    const result = await auth.logIn(typeof form.password === 'string' ? form.password : '');
    if (result.ok) {
      setCookie(c, SESSION_COOKIE, result.token, {
        ...cookieOptions(),
        maxAge: SESSION_LIFETIME_SECONDS,
      });
      return c.redirect(next, 303);
    }
    if (result.reason === 'rate-limited') {
      c.header('Retry-After', String(result.retryAfterSeconds));
      const minutes = Math.ceil(result.retryAfterSeconds / 60);
      return loginPage(
        c,
        next,
        429,
        `Too many login attempts. Try again in ${String(minutes)} ${minutes === 1 ? 'minute' : 'minutes'}.`,
      );
    }
    return loginPage(c, next, 401, 'Incorrect password.');
  });

  app.post('/logout', async (c) => {
    const auth = await resolveAuth();
    if (auth === undefined) {
      return c.notFound();
    }
    await auth.logOut(getCookie(c, SESSION_COOKIE));
    deleteCookie(c, SESSION_COOKIE, cookieOptions());
    return c.redirect('/login', 303);
  });

  app.get('/keys', async (c) => {
    const auth = await resolveAuth();
    if (auth === undefined) {
      return c.notFound();
    }
    return apiKeysPage(c, auth, {});
  });

  // Answers with the page rather than a redirect, so the new key is never in
  // a URL, and marks it no-store, so no cache or history keeps the key.
  app.post('/keys', bodyLimit({ maxSize: MAX_FORM_BODY_BYTES }), async (c) => {
    const auth = await resolveAuth();
    if (auth === undefined) {
      return c.notFound();
    }
    const form = await c.req.parseBody();
    const name = typeof form.name === 'string' ? form.name.trim() : '';
    if (name === '' || name.length > MAX_API_KEY_NAME_LENGTH) {
      return apiKeysPage(c, auth, {
        error: `Give the key a name of 1 to ${String(MAX_API_KEY_NAME_LENGTH)} characters.`,
        status: 400,
      });
    }
    const { key } = await auth.createApiKey(name);
    c.header('Cache-Control', 'no-store');
    return apiKeysPage(c, auth, { created: { key, name } });
  });

  app.post('/keys/:id/revoke', async (c) => {
    const auth = await resolveAuth();
    if (auth === undefined) {
      return c.notFound();
    }
    await auth.revokeApiKey(c.req.param('id'));
    return c.redirect('/keys', 303);
  });
}
