import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { CookieOptions } from 'hono/utils/cookie';
import { z } from 'zod';

import { ApiKeysPage } from '../components/api-keys-page.js';
import { Layout } from '../components/layout.js';
import { LoginPage } from '../components/login-page.js';
import { isOwnOrigin, resolvePublicBaseUrl } from '../urls.js';
import { SESSION_LIFETIME_SECONDS } from './owner-auth.js';
import type { CreatedApiKey, OwnerAuth } from './owner-auth.js';

export const SESSION_COOKIE = 'artifacts_session';
// Carries a new key from the create form's POST to the GET its redirect
// asks for, which shows the key once and deletes the cookie. It is scoped to
// /keys and lasts a minute, so an unfollowed redirect does not leave the
// key in the browser for long.
const NEW_KEY_COOKIE = 'artifacts_new_key';
const NEW_KEY_COOKIE_SECONDS = 60;

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

function newKeyCookieOptions(): CookieOptions {
  return { ...cookieOptions(), path: '/keys', sameSite: 'Strict' };
}

// The key a create form's POST left for this page, deleting it so a refresh
// does not show it again. The id and the key hold no `.`.
function takeNewKey(c: Context): CreatedApiKey | undefined {
  const value = getCookie(c, NEW_KEY_COOKIE);
  if (value === undefined) {
    return undefined;
  }
  deleteCookie(c, NEW_KEY_COOKIE, newKeyCookieOptions());
  const [id, key, ...rest] = value.split('.');
  return id === undefined || key === undefined || rest.length > 0 ? undefined : { id, key };
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

// The part of @hono/node-server's request bindings that names the peer.
// Other runtimes, and app.request() in tests, pass no such bindings.
const NODE_SOCKET = z.object({ remoteAddress: z.string().optional() });
const NODE_PEER = z.object({ incoming: z.object({ socket: NODE_SOCKET }) });

// The address a login attempt counts against. It is the header the operator
// named, which a trusted proxy sets, and otherwise the connection's peer
// address on Node. A header that is not named is never read, since any client
// can send one. For a list such as X-Forwarded-For the last entry is used:
// the nearest proxy appends it, while a client can write the ones before it.
// Empty when neither is known, so all such attempts share one count.
function clientAddress(c: Context, header: string | undefined): string {
  const fromProxy = header === undefined ? undefined : c.req.header(header)?.split(',').at(-1);
  if (fromProxy !== undefined && fromProxy.trim() !== '') {
    return fromProxy.trim();
  }
  return NODE_PEER.safeParse(c.env).data?.incoming.socket.remoteAddress ?? '';
}

// The token from an `Authorization: Bearer <token>` header. The scheme is
// case-insensitive (RFC 9110); anything else yields undefined.
function bearerToken(header: string | undefined): string | undefined {
  return header === undefined ? undefined : /^Bearer +(\S+) *$/iu.exec(header)?.[1];
}

// The key page. A new key is shown only while it still exists, so a key
// revoked before the redirect landed is not offered for use.
async function apiKeysPage(
  c: Context,
  auth: OwnerAuth,
  props: { error?: string; newKey?: CreatedApiKey; status?: 200 | 400 },
) {
  const keys = await auth.listApiKeys();
  const newKeyName =
    props.newKey === undefined ? undefined : keys.find(({ id }) => id === props.newKey?.id)?.name;
  return c.html(
    <Layout title="API keys · Artifacts">
      <ApiKeysPage
        created={
          props.newKey === undefined || newKeyName === undefined
            ? undefined
            : { key: props.newKey.key, name: newKeyName }
        }
        error={props.error}
        keys={keys}
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
async function hasValidSignature(c: Context, auth: OwnerAuth): Promise<boolean> {
  const id = SIGNED_READ_PATH.exec(c.req.path)?.[1];
  return (
    SAFE_METHODS.has(c.req.method) &&
    id !== undefined &&
    (await auth.artifactUrls.verify(id, new URL(c.req.url).searchParams))
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
    return (await hasValidSignature(c, auth)) ? undefined : c.text('Forbidden', 403);
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
    const result = await auth.logIn(
      typeof form.password === 'string' ? form.password : '',
      clientAddress(c, auth.clientAddressHeader),
    );
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
    const newKey = takeNewKey(c);
    if (newKey !== undefined) {
      // No cache or history keeps the page that shows the key.
      c.header('Cache-Control', 'no-store');
    }
    return apiKeysPage(c, auth, { newKey });
  });

  // Redirects so a refresh repeats the GET, not the POST, and creates no
  // second key. The key travels in a cookie, so it is never in a URL.
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
    const { id, key } = await auth.createApiKey(name);
    setCookie(c, NEW_KEY_COOKIE, `${id}.${key}`, {
      ...newKeyCookieOptions(),
      maxAge: NEW_KEY_COOKIE_SECONDS,
    });
    return c.redirect('/keys', 303);
  });

  app.post('/keys/revoke-all', async (c) => {
    const auth = await resolveAuth();
    if (auth === undefined) {
      return c.notFound();
    }
    await auth.revokeAllApiKeys();
    return c.redirect('/keys', 303);
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
