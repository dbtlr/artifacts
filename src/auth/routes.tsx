import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { CookieOptions } from 'hono/utils/cookie';

import { Layout } from '../components/layout.js';
import { LoginPage } from '../components/login-page.js';
import { resolvePublicBaseUrl } from '../urls.js';
import { SESSION_LIFETIME_SECONDS } from './owner-auth.js';
import type { OwnerAuth } from './owner-auth.js';

export const SESSION_COOKIE = 'artifacts_session';

const MAX_LOGIN_BODY_BYTES = 16 * 1024;
const SAFE_METHODS = new Set(['GET', 'HEAD']);
// Served without a session: the login form and the static files it uses.
const ICON_PATHS = new Set(['/apple-touch-icon.png', '/favicon.ico', '/favicon.svg']);

function isPublicPath(path: string): boolean {
  return path === '/login' || path.startsWith('/assets/') || ICON_PATHS.has(path);
}

// Where a login may send the browser afterwards: a path on this server only.
// Anything else, including `//host` and `/\host` (which browsers read as
// another host), falls back to the home page.
export function safeNextPath(value: unknown): string {
  if (typeof value !== 'string' || !/^\/(?![/\\])/u.test(value)) {
    return '/';
  }
  const base = 'http://artifacts.invalid';
  const url = new URL(value, base);
  return url.origin === base ? `${url.pathname}${url.search}` : '/';
}

// A state-changing request must name its origin, and that origin must be
// this server as the request reached it or as its public base URL names it
// (they differ behind a proxy). Browsers send Origin on every POST, so a
// missing one means a non-browser client or an old browser, and `null`
// means a sandboxed artifact or a privacy redirect; all are refused.
function hasAllowedOrigin(c: Context): boolean {
  const origin = c.req.header('Origin');
  return (
    origin !== undefined &&
    (origin === new URL(c.req.url).origin || origin === new URL(resolvePublicBaseUrl()).origin)
  );
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

function loginPage(c: Context, next: string, status: 200 | 401 | 429, error?: string) {
  return c.html(
    <Layout title="Log in · Artifacts">
      <LoginPage error={error} next={next} />
    </Layout>,
    status,
  );
}

// The response for a request that auth on does not let through, or
// undefined when it may proceed.
async function refuseWithoutSession(c: Context, auth: OwnerAuth): Promise<Response | undefined> {
  const url = new URL(c.req.url);
  // MCP clients cannot hold a session cookie, and /mcp has no credential of
  // its own yet, so it stays closed while auth is on.
  if (url.pathname === '/mcp') {
    return c.text('Unauthorized: /mcp is unavailable while owner auth is on', 401);
  }
  if (!SAFE_METHODS.has(c.req.method) && !hasAllowedOrigin(c)) {
    return c.text('Forbidden', 403);
  }
  if (isPublicPath(url.pathname) || (await auth.hasSession(getCookie(c, SESSION_COOKIE)))) {
    return undefined;
  }
  if (SAFE_METHODS.has(c.req.method)) {
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
    return next().then(() => markPrivate(c.res));
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

  app.post('/login', bodyLimit({ maxSize: MAX_LOGIN_BODY_BYTES }), async (c) => {
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
}
