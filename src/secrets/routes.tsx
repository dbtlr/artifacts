import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';

import { Layout } from '../components/layout.js';
import { SecretPage, SecretUnavailablePage } from '../components/secret-page.js';
import { formatTimeLeft } from '../format-date.js';
import { buildSecretViewUrl } from '../urls.js';
import { InvalidSecretInputError } from './errors.js';
import { MAX_SECRET_BYTES } from './service.js';
import type { SecretService } from './types.js';

// The service enforces the exact size limit, so an upload one byte over it is
// an ordinary refusal; this only stops a far larger body from being read.
const MAX_UPLOAD_BODY_BYTES = MAX_SECRET_BYTES + 1;
// A reveal's form holds only the 43-character key.
const MAX_REVEAL_BODY_BYTES = 1024;

// The secret pages load only this server's stylesheet, icons, and script,
// and refuse every frame, so a page cannot be framed to steer the Reveal
// click. The owner-auth guard keeps a policy that already denies frames.
const SECRET_PAGE_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

// No cache or history keeps a secret response, and no link on a secret page
// tells another site where it came from.
const NO_STORE = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };

const PAGE_HEADERS = {
  ...NO_STORE,
  'Content-Security-Policy': SECRET_PAGE_CSP,
  'X-Frame-Options': 'DENY',
};

function markNoStore(res: Response): void {
  res.headers.set('Cache-Control', 'no-store');
}

const PAGE_TITLE = 'One-time secret · Muninn';

// Every refusal is the same bare 404, so a caller learns nothing about why.
function refuse(c: Context) {
  return c.body(null, 404, NO_STORE);
}

// The one-time secret routes (ADR-0008). `resolveSecrets` resolves undefined
// when the app has no secret service; then every route here is a 404. With
// owner auth on, these three routes need no session: see the exemptions in
// auth/routes.tsx.
export function installSecretRoutes(
  app: Hono,
  resolveSecrets: () => Promise<SecretService | undefined>,
): void {
  // Every response under /s/, including an error a route did not foresee,
  // is kept by no cache.
  app.use('/s/*', async (c, runRoute) => {
    await runRoute();
    markNoStore(c.res);
  });

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
      return new Response(new Uint8Array(revealed.content).buffer, {
        headers: {
          ...NO_STORE,
          'Content-Type': 'application/octet-stream',
          'X-Content-Type-Options': 'nosniff',
        },
        status: 200,
      });
    },
  );
}
