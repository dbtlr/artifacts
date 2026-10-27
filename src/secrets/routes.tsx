import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';

import { showOnceCookieOptions } from '../auth/cookies.js';
import { Layout } from '../components/layout.js';
import {
  EXPIRY_CHOICES,
  NewSecretPage,
  SecretHandlePage,
  SecretPage,
  SecretUnavailablePage,
} from '../components/secret-page.js';
import { formatTimeLeft } from '../format-date.js';
import { buildSecretViewUrl } from '../urls.js';
import { InvalidSecretInputError, SecretLimitError } from './errors.js';
import { formatHandle, parseHandle } from './handle.js';
import { DEFAULT_TTL_SECONDS, MAX_SECRET_BYTES, SECRET_LIMIT } from './service.js';
import type { SecretService } from './types.js';

// The service enforces the exact size limit, so an upload one byte over it is
// an ordinary refusal; this only stops a far larger body from being read.
const MAX_UPLOAD_BODY_BYTES = MAX_SECRET_BYTES + 1;
// A reveal's form holds only the 43-character key.
const MAX_REVEAL_BODY_BYTES = 1024;
// The owner's form holds a secret of up to MAX_SECRET_BYTES, which form
// encoding can grow sixfold (a line break is sent as `%0D%0A`), and a label
// and an expiry. The service enforces the exact limit.
const MAX_NEW_SECRET_BODY_BYTES = 6 * MAX_SECRET_BYTES + 4096;

const NEW_SECRET_PATH = '/secrets/new';
// Carries a new secret's handle from the form's POST to the GET its redirect
// asks for, which shows the handle once and deletes the cookie. It is scoped
// to the page and lasts a minute, so an unfollowed redirect does not leave
// the handle in the browser for long (the API keys page does the same; see
// auth/cookies.ts).
const NEW_SECRET_COOKIE = 'muninn_new_secret';
const NEW_SECRET_COOKIE_SECONDS = 60;

// The secret pages load only this server's stylesheet, icons, and script,
// and refuse every frame, so a page cannot be framed to steer the Reveal
// click. The owner-auth guard keeps a policy that already denies frames.
// `formAction` is where the page's forms may submit.
function secretPageCsp(formAction: "'none'" | "'self'"): string {
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self'",
    "connect-src 'self'",
    "base-uri 'none'",
    `form-action ${formAction}`,
    "frame-ancestors 'none'",
  ].join('; ');
}

// No cache or history keeps a secret response, and no link on a secret page
// tells another site where it came from.
const NO_STORE = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };

const PAGE_HEADERS = {
  ...NO_STORE,
  'Content-Security-Policy': secretPageCsp("'none'"),
  'X-Frame-Options': 'DENY',
};

// The owner's new-secret pages may submit their own form, and nothing else.
const NEW_SECRET_PAGE_HEADERS = {
  ...PAGE_HEADERS,
  'Content-Security-Policy': secretPageCsp("'self'"),
};

// A secret's bytes, and every refusal of a download, are never sniffed into
// something a browser would render.
const BYTES_HEADERS = { ...NO_STORE, 'X-Content-Type-Options': 'nosniff' };

const NO_SECRET = 'Enter a secret.';
const TOO_LARGE = 'Enter a secret of at most 64 KiB.';
const UNREADABLE_FORM = 'The form could not be read. Try again.';
const STORE_FULL = `Muninn already holds ${String(SECRET_LIMIT)} unread secrets. Try again once some are read or expire.`;

// What the new-secret form says about input the service refused. The
// messages never quote the input.
const INPUT_ERRORS: Record<Exclude<InvalidSecretInputError['field'], 'content'>, string> = {
  filename: UNREADABLE_FORM,
  label: 'Give the secret a label of 1 to 100 characters, with no control characters.',
  ttlSeconds: 'Choose when the secret expires.',
};

// The message for a refused field, given the content the service refused.
function inputError(field: InvalidSecretInputError['field'], content: Uint8Array): string {
  if (field === 'content') {
    return content.byteLength === 0 ? NO_SECRET : TOO_LARGE;
  }
  return INPUT_ERRORS[field];
}

// Keeps a `no-store` the response already has (owner auth sends
// `private, no-store`) and adds it to any response that lacks one.
function markNoStore(res: Response): void {
  if (!/\bno-store\b/u.test(res.headers.get('Cache-Control') ?? '')) {
    res.headers.set('Cache-Control', 'no-store');
  }
}

// Every response under /s/, including an owner-auth refusal and an error a
// route did not foresee, is kept by no cache. Install it before owner auth,
// so it also wraps the guard's refusals.
export function installSecretNoStore(app: Hono): void {
  app.use('/s/*', async (c, runRoute) => {
    await runRoute();
    markNoStore(c.res);
  });
}

const PAGE_TITLE = 'One-time secret · Muninn';

// Every refusal is the same bare 404, so a caller learns nothing about why.
function refuse(c: Context) {
  return c.body(null, 404, NO_STORE);
}

function refuseDownload(c: Context) {
  return c.body(null, 404, BYTES_HEADERS);
}

function secretBytes(content: Uint8Array): Response {
  return new Response(new Uint8Array(content).buffer, {
    headers: { ...BYTES_HEADERS, 'Content-Type': 'application/octet-stream' },
    status: 200,
  });
}

// The handle a create's POST left for the page, deleting it so a refresh
// does not show it again. A replayed cookie, from concurrent GETs or a value
// resent after the deletion, shows the handle again; the cookie's value is
// the handle, so a replay reveals nothing its sender did not already hold.
// The API keys page behaves the same.
function takeNewHandle(c: Context): { id: string; key: string } | null {
  const value = getCookie(c, NEW_SECRET_COOKIE);
  if (value === undefined) {
    return null;
  }
  deleteCookie(c, NEW_SECRET_COOKIE, showOnceCookieOptions(NEW_SECRET_PATH));
  return parseHandle(value);
}

type NewSecretForm = { error?: string; expires?: number; label?: string };

function newSecretForm(c: Context, status: 200 | 400 | 413 | 503, form: NewSecretForm = {}) {
  return c.html(
    <Layout title="New secret · Muninn">
      <NewSecretPage
        error={form.error}
        expires={form.expires ?? DEFAULT_TTL_SECONDS}
        label={form.label ?? ''}
      />
    </Layout>,
    status,
    NEW_SECRET_PAGE_HEADERS,
  );
}

// One of the form's expiry choices in seconds, or undefined.
function expiryChoice(value: unknown): number | undefined {
  return EXPIRY_CHOICES.find(({ seconds }) => String(seconds) === value)?.seconds;
}

// The one-time secret routes (ADR-0008). `resolveSecrets` resolves undefined
// when the app has no secret service; then every route here is a 404. With
// owner auth on, the routes under /s/ need no session: see the exemptions in
// auth/routes.tsx. The owner's /secrets/new does.
export function installSecretRoutes(
  app: Hono,
  resolveSecrets: () => Promise<SecretService | undefined>,
): void {
  // The upload URL an agent pipes a secret into with
  // `curl -fsS --data-binary @- "$uploadUrl"`. The raw body is the secret. The
  // response body is only the view link and a newline, so curl prints
  // nothing else. Registered before the reveal route, which `/s/upload/reveal`
  // also matches.
  app.post(
    '/s/upload/:token',
    bodyLimit({
      maxSize: MAX_UPLOAD_BODY_BYTES,
      onError: (c) => c.body(null, 413, NO_STORE),
    }),
    async (c) => {
      const secrets = await resolveSecrets();
      if (secrets === undefined) {
        return refuse(c);
      }
      const content = new Uint8Array(await c.req.arrayBuffer());
      let created;
      try {
        created = await secrets.upload(c.req.param('token'), content);
      } catch (error) {
        if (error instanceof InvalidSecretInputError) {
          return refuse(c);
        }
        throw error;
      }
      if (created === null) {
        return refuse(c);
      }
      return c.text(`${buildSecretViewUrl(created.id, created.key)}\n`, 201, NO_STORE);
    },
  );

  // The download URL `claim_secret` returns, which an agent pipes into a
  // command with `curl -fsS -X POST "$downloadUrl" | <command>`. The token
  // authorizes it and works once; it responds with the secret's bytes and
  // burns the secret. Every other method, and every failure, is the same
  // bare 404. Registered before the reveal route, which
  // `/s/download/reveal` also matches.
  app.post('/s/download/:token', async (c) => {
    const secrets = await resolveSecrets();
    const revealed = secrets === undefined ? null : await secrets.download(c.req.param('token'));
    return revealed === null ? refuseDownload(c) : secretBytes(revealed.content);
  });
  app.all('/s/download/:token', refuseDownload);

  // The view link's page. Only `find` decides what it shows, never `status`,
  // so a pending secret gets the ready page and anything else gets the one
  // unavailable page.
  app.get('/s/:id', async (c) => {
    const secrets = await resolveSecrets();
    if (secrets === undefined) {
      return c.notFound();
    }
    const found = await secrets.find(c.req.param('id'));
    if (found === null) {
      return c.html(
        <Layout title={PAGE_TITLE}>
          <SecretUnavailablePage />
        </Layout>,
        404,
        PAGE_HEADERS,
      );
    }
    return c.html(
      <Layout title={PAGE_TITLE}>
        <SecretPage
          expiresIn={formatTimeLeft(found.expiresAt, new Date())}
          filename={found.filename}
          label={found.label}
        />
      </Layout>,
      200,
      PAGE_HEADERS,
    );
  });

  // Reveal: a form POST with one field, `key`, the view link's fragment. It
  // responds with the secret's bytes and burns it. A wrong key burns nothing,
  // and neither does a body that is too large or cannot be parsed.
  app.post(
    '/s/:id/reveal',
    bodyLimit({ maxSize: MAX_REVEAL_BODY_BYTES, onError: refuse }),
    async (c) => {
      const secrets = await resolveSecrets();
      if (secrets === undefined) {
        return refuse(c);
      }
      let form;
      try {
        form = await c.req.parseBody();
      } catch {
        return refuse(c);
      }
      const key = typeof form.key === 'string' ? form.key : '';
      const revealed = await secrets.reveal(c.req.param('id'), key);
      if (revealed === null) {
        return refuse(c);
      }
      return secretBytes(revealed.content);
    },
  );

  installNewSecretRoutes(app, resolveSecrets);
}

// The owner's form for a new secret (ADR-0008). With owner auth on, it needs
// the owner's session and the Origin rule like any other page; with auth off
// it is open, like the rest of a trusted-network Muninn. The POST redirects
// so a refresh repeats the GET, not the POST, and seals no second secret.
// The handle travels in a cookie, so it is never in a URL.
function installNewSecretRoutes(
  app: Hono,
  resolveSecrets: () => Promise<SecretService | undefined>,
): void {
  // No cache keeps any response here, including the redirect that carries
  // the handle's cookie and an error no route foresaw. Owner auth, installed
  // before this, then adds `private`.
  app.use(NEW_SECRET_PATH, async (c, runRoute) => {
    await runRoute();
    markNoStore(c.res);
  });

  app.get(NEW_SECRET_PATH, async (c) => {
    const secrets = await resolveSecrets();
    if (secrets === undefined) {
      return c.notFound();
    }
    const handle = takeNewHandle(c);
    // A secret read or expired before the redirect landed is not offered.
    const found = handle === null ? null : await secrets.find(handle.id);
    if (handle === null || found === null) {
      return newSecretForm(c, 200);
    }
    return c.html(
      <Layout title="New secret · Muninn">
        <SecretHandlePage
          expiresAt={found.expiresAt}
          handle={formatHandle(handle.id, handle.key)}
          label={found.label}
        />
      </Layout>,
      200,
      NEW_SECRET_PAGE_HEADERS,
    );
  });

  app.post(
    NEW_SECRET_PATH,
    bodyLimit({
      maxSize: MAX_NEW_SECRET_BODY_BYTES,
      onError: (c) => newSecretForm(c, 413, { error: TOO_LARGE }),
    }),
    async (c) => {
      const secrets = await resolveSecrets();
      if (secrets === undefined) {
        return c.notFound();
      }
      let body;
      try {
        body = await c.req.parseBody();
      } catch {
        return newSecretForm(c, 400, { error: UNREADABLE_FORM });
      }
      const label = typeof body.label === 'string' ? body.label : '';
      const expires = expiryChoice(body.expires);
      if (expires === undefined) {
        return newSecretForm(c, 400, { error: INPUT_ERRORS.ttlSeconds, label });
      }
      // A browser sends a textarea's line breaks as CRLF whatever was typed
      // or pasted; the secret keeps the LF a file or terminal would hold.
      const secret = typeof body.secret === 'string' ? body.secret.replaceAll('\r\n', '\n') : '';
      const content = new TextEncoder().encode(secret);
      let created;
      try {
        created = await secrets.create({ content, label, ttlSeconds: expires });
      } catch (error) {
        if (error instanceof InvalidSecretInputError) {
          return newSecretForm(c, 400, { error: inputError(error.field, content), expires, label });
        }
        if (error instanceof SecretLimitError) {
          return newSecretForm(c, 503, { error: STORE_FULL, expires, label });
        }
        throw error;
      }
      setCookie(c, NEW_SECRET_COOKIE, formatHandle(created.id, created.key), {
        ...showOnceCookieOptions(NEW_SECRET_PATH),
        maxAge: NEW_SECRET_COOKIE_SECONDS,
      });
      return c.redirect(NEW_SECRET_PATH, 303);
    },
  );
}
