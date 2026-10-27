import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';

import { createApp } from '../app.js';
import { createOwnerAuth } from '../auth/owner-auth.js';
import { SqliteOwnerAuthStore } from '../data/sqlite-owner-auth-store.js';
import { SqliteSecretStore } from '../data/sqlite-secret-store.js';
import type { ArtifactService } from '../data/store.js';
import { createByteNativeArtifactService } from '../data/store.js';
import { SecretLimitError } from './errors.js';
import { parseHandle } from './handle.js';
import {
  CLAIM_LIFETIME_SECONDS,
  createSecretService,
  MAX_SECRET_BYTES,
  SECRET_LIMIT,
  UPLOAD_SLOT_LIFETIME_SECONDS,
} from './service.js';
import type { SecretService } from './types.js';

const PASSWORD = 'correct horse battery staple';
// app.request() resolves paths against http://localhost.
const ORIGIN = 'http://localhost';
const BASE_URL = 'https://muninn.example';
const SECRET = 'hunter2-staging-db-password';
// A well-formed key that opens nothing.
const WRONG_KEY = 'B'.repeat(43);
// The whole policy on both secret pages, pinned so that loosening any
// directive fails a test.
const SECRET_PAGE_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; " +
  "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
// A form body the browser would never send for a reveal: multipart with a
// boundary that never appears.
const MALFORMED_MULTIPART: RequestInit = {
  body: 'not multipart at all',
  headers: { 'Content-Type': 'multipart/form-data; boundary=x', Origin: ORIGIN },
  method: 'POST',
};

let dataDir: string;
let artifacts: ArtifactService;
let secrets: SecretService;
let clock: Date;
const originalBaseUrl = process.env.MUNINN_PUBLIC_BASE_URL;

beforeEach(async () => {
  process.env.MUNINN_PUBLIC_BASE_URL = BASE_URL;
  dataDir = await mkdtemp(join(tmpdir(), 'muninn-secret-routes-'));
  const databasePath = join(dataDir, 'artifacts.db');
  artifacts = await createByteNativeArtifactService({
    databasePath,
    filesDir: join(dataDir, 'artifacts'),
  });
  clock = new Date();
  secrets = createSecretService({
    now: () => clock,
    store: await SqliteSecretStore.open(databasePath),
  });
});

afterEach(async () => {
  await rm(dataDir, { force: true, recursive: true });
  if (originalBaseUrl === undefined) {
    delete process.env.MUNINN_PUBLIC_BASE_URL;
  } else {
    process.env.MUNINN_PUBLIC_BASE_URL = originalBaseUrl;
  }
});

function advance(seconds: number): void {
  clock = new Date(clock.getTime() + seconds * 1000);
}

// An upload as curl sends one: raw bytes, no Origin, no cookie.
function uploadRequest(body: BodyInit): RequestInit {
  return {
    body,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    method: 'POST',
  };
}

// A reveal as the page's script sends one: the key as a form field, from
// this server's origin unless `origin` names another, or null for none.
function revealRequest(key: string, origin: string | null = ORIGIN): RequestInit {
  return {
    body: new URLSearchParams({ key }).toString(),
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(origin === null ? {} : { Origin: origin }),
    },
    method: 'POST',
  };
}

// The id and key in a view link.
function parseViewLink(link: string): { id: string; key: string } {
  const match = new RegExp(`^${BASE_URL}/s/([\\w-]{22})#([\\w-]{43})$`, 'u').exec(link);
  if (match === null) {
    throw new Error(`not a view link: ${link}`);
  }
  return { id: match[1]!, key: match[2]! };
}

type TestApp = ReturnType<typeof createApp>;

// A handle as the new-secret page shows it.
const HANDLE = /sec_[\w-]{22}\.[\w-]{43}/u;

// A form POST from this server's origin, as the new-secret page sends it.
function formRequest(fields: Record<string, string>, headers: Record<string, string>): RequestInit {
  return {
    body: new URLSearchParams(fields).toString(),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: ORIGIN, ...headers },
    method: 'POST',
  };
}

// A download as `curl -fsS -X POST "$downloadUrl"` sends one: no body, no
// Origin, no cookie.
const DOWNLOAD: RequestInit = { method: 'POST' };

// The `name=value` pair a browser would send back from a Set-Cookie header.
function cookiePair(res: Response): string {
  const header = res.headers.get('set-cookie');
  if (header === null) {
    throw new Error('response set no cookie');
  }
  return header.split(';')[0]!;
}

async function logIn(app: TestApp): Promise<string> {
  const res = await app.request('/login', formRequest({ password: PASSWORD }, {}));
  expect(res.status).toBe(303);
  return cookiePair(res);
}

// A secret service that counts the secrets the owner's form asks it to create.
function countingCreates(service: SecretService): { count: () => number; service: SecretService } {
  let creates = 0;
  return {
    count: () => creates,
    service: {
      ...service,
      create: async (input) => {
        creates += 1;
        return service.create(input);
      },
    },
  };
}

// A claim token for a new owner secret holding `content`.
async function claimToken(content: Uint8Array | string = SECRET): Promise<string> {
  const { id, key } = await secrets.create({
    content: typeof content === 'string' ? new TextEncoder().encode(content) : content,
    label: 'Deploy token',
  });
  const claim = await secrets.claim(id, key);
  if (claim === null) {
    throw new Error('claim failed');
  }
  return claim.claimToken;
}

function expectBareRefusal(res: Response): void {
  expect(res.status).toBe(404);
  expect(res.headers.get('cache-control')).toContain('no-store');
  expect(res.headers.get('x-content-type-options')).toBe('nosniff');
}

// Stands in for any secret service call when the store is down.
async function failStore(): Promise<never> {
  throw new Error('store unavailable');
}

async function uploadSecret(
  app: TestApp,
  { content = SECRET, filename }: { content?: string; filename?: string } = {},
): Promise<{ id: string; key: string }> {
  const { uploadToken } = await secrets.createUpload({
    label: 'Staging DB password',
    ...(filename === undefined ? {} : { filename }),
  });
  const res = await app.request(`/s/upload/${uploadToken}`, uploadRequest(content));
  expect(res.status).toBe(201);
  return parseViewLink((await res.text()).trimEnd());
}

const modes = [
  { authOn: false, name: 'with no owner password' },
  { authOn: true, name: 'with an owner password' },
];

describe.each(modes)('secret routes $name', ({ authOn }) => {
  let app: TestApp;
  let auth: ReturnType<typeof createOwnerAuth> | undefined;
  let creates: () => number;
  // What a browser sends with the owner's requests: a session cookie when
  // auth is on, nothing when it is off.
  let session: Record<string, string>;

  function appWith(service: SecretService): TestApp {
    return createApp({
      artifacts,
      ...(auth === undefined ? {} : { auth }),
      mcp: artifacts,
      secrets: service,
    });
  }

  beforeEach(async () => {
    auth = authOn
      ? createOwnerAuth({
          password: PASSWORD,
          store: await SqliteOwnerAuthStore.open(join(dataDir, 'artifacts.db')),
        })
      : undefined;
    const counting = countingCreates(secrets);
    creates = counting.count;
    app = appWith(counting.service);
    session = authOn ? { Cookie: await logIn(app) } : {};
  });

  describe('POST /s/upload/:token', () => {
    it('stores the body and responds with only the view link and a newline', async () => {
      const { uploadToken } = await secrets.createUpload({ label: 'Staging DB password' });

      const res = await app.request(`/s/upload/${uploadToken}`, uploadRequest(SECRET));

      expect(res.status).toBe(201);
      expect(res.headers.get('content-type')).toMatch(/^text\/plain/u);
      expect(res.headers.get('cache-control')).toContain('no-store');
      const body = await res.text();
      expect(body).toMatch(new RegExp(`^${BASE_URL}/s/[\\w-]{22}#[\\w-]{43}\\n$`, 'u'));
      expect(body).not.toContain(SECRET);
      const { id, key } = parseViewLink(body.trimEnd());
      const revealed = await secrets.reveal(id, key);
      expect(new TextDecoder().decode(revealed?.content)).toBe(SECRET);
    });

    it('refuses an unknown, malformed, used, or expired token with a bare 404', async () => {
      const used = await secrets.createUpload({ label: 'Used' });
      expect(
        (await app.request(`/s/upload/${used.uploadToken}`, uploadRequest(SECRET))).status,
      ).toBe(201);
      const expired = await secrets.createUpload({ label: 'Expired' });
      advance(UPLOAD_SLOT_LIFETIME_SECONDS + 1);

      const tokens = ['A'.repeat(43), 'not-a-token', used.uploadToken, expired.uploadToken];
      const responses = await Promise.all(
        tokens.map(async (token) => app.request(`/s/upload/${token}`, uploadRequest(SECRET))),
      );

      expect(responses.map((res) => res.status)).toEqual([404, 404, 404, 404]);
      const bodies = await Promise.all(responses.map((res) => res.text()));
      expect(bodies).toEqual(['', '', '', '']);
    });

    it('refuses an empty or oversized body, and the token still works afterwards', async () => {
      const { uploadToken } = await secrets.createUpload({ label: 'Retry' });
      const path = `/s/upload/${uploadToken}`;

      const empty = await app.request(path, uploadRequest(''));
      const overByOne = await app.request(
        path,
        uploadRequest(new Uint8Array(MAX_SECRET_BYTES + 1).fill(97)),
      );
      const huge = await app.request(
        path,
        uploadRequest(new Uint8Array(MAX_SECRET_BYTES * 2).fill(97)),
      );
      const atLimit = await app.request(
        path,
        uploadRequest(new Uint8Array(MAX_SECRET_BYTES).fill(97)),
      );

      expect(empty.status).toBe(404);
      await expect(empty.text()).resolves.toBe('');
      expect(overByOne.status).toBe(404);
      expect(huge.status).toBe(413);
      expect(huge.headers.get('cache-control')).toContain('no-store');
      await expect(huge.text()).resolves.toBe('');
      expect(atLimit.status).toBe(201);
    });

    it('stores a body with a multipart type as raw bytes, without parsing it', async () => {
      const { uploadToken } = await secrets.createUpload({ label: 'Multipart' });

      const res = await app.request(`/s/upload/${uploadToken}`, MALFORMED_MULTIPART);

      expect(res.status).toBe(201);
      const { id, key } = parseViewLink((await res.text()).trimEnd());
      const revealed = await secrets.reveal(id, key);
      expect(new TextDecoder().decode(revealed?.content)).toBe('not multipart at all');
    });

    it('accepts an upload with no Origin and with a foreign Origin, needing no cookie', async () => {
      const first = await secrets.createUpload({ label: 'No origin' });
      const second = await secrets.createUpload({ label: 'Foreign origin' });

      const noOrigin = await app.request(`/s/upload/${first.uploadToken}`, uploadRequest(SECRET));
      const foreign = await app.request(`/s/upload/${second.uploadToken}`, {
        ...uploadRequest(SECRET),
        headers: { Origin: 'https://evil.example' },
      });

      expect(noOrigin.status).toBe(201);
      expect(foreign.status).toBe(201);
    });
  });

  describe('GET /s/:id', () => {
    it('shows a pending secret’s label, filename, and expiry with a Reveal once button', async () => {
      const { id, key } = await uploadSecret(app, { filename: 'staging.env' });

      const res = await app.request(`/s/${id}`);

      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain('Staging DB password');
      expect(body).toContain('staging.env');
      expect(body).toContain('From an agent · expires in 23 h');
      expect(body).toContain('Reveal once');
      // Where the script says the link lost its key or Muninn was unreachable.
      expect(body).toMatch(/<p id="secret-notice"[^>]*\shidden[^>]*><\/p>/u);
      expect(body).toContain('<noscript>');
      expect(body).toContain('src="/assets/secret.js"');
      expect(body).not.toContain(key);
      expect(body).not.toContain(SECRET);
      // No inline script or inline event handler.
      expect(body).not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>/u);
      expect(body).not.toMatch(/\son[a-z]+=/u);
    });

    it('serves its pages so no cache keeps them, no link leaks them, and no frame holds them', async () => {
      const { id } = await uploadSecret(app);
      const unavailable = await app.request('/s/AAAAAAAAAAAAAAAAAAAAAA');

      for (const res of [await app.request(`/s/${id}`), unavailable]) {
        expect(res.headers.get('cache-control')).toContain('no-store');
        expect(res.headers.get('referrer-policy')).toBe('no-referrer');
        expect(res.headers.get('x-frame-options')).toBe('DENY');
        expect(res.headers.get('content-security-policy')).toBe(SECRET_PAGE_CSP);
      }
    });

    it('shows one unavailable page for a read, expired, unknown, or malformed id', async () => {
      const read = await uploadSecret(app);
      await secrets.reveal(read.id, read.key);
      const { uploadToken } = await secrets.createUpload({ label: 'Expires', ttlSeconds: 3600 });
      const expiring = await app.request(`/s/upload/${uploadToken}`, uploadRequest(SECRET));
      const expired = parseViewLink((await expiring.text()).trimEnd());
      advance(3601);

      const ids = [read.id, expired.id, 'AAAAAAAAAAAAAAAAAAAAAA', 'not-a-secret-id'];
      const responses = await Promise.all(ids.map(async (id) => app.request(`/s/${id}`)));

      expect(responses.map((res) => res.status)).toEqual([404, 404, 404, 404]);
      const bodies = await Promise.all(responses.map((res) => res.text()));
      expect(bodies[0]).toContain('Nothing to reveal');
      expect(new Set(bodies).size).toBe(1);
      expect(bodies[0]).not.toContain('Staging DB password');
    });

    it('never calls status for the page', async () => {
      const { id } = await uploadSecret(app);
      const spied = { ...secrets, status: () => Promise.reject(new Error('status called')) };
      const spiedApp = createApp({ artifacts, mcp: artifacts, secrets: spied });

      expect((await spiedApp.request(`/s/${id}`)).status).toBe(200);
      expect((await spiedApp.request('/s/AAAAAAAAAAAAAAAAAAAAAA')).status).toBe(404);
    });
  });

  describe('POST /s/:id/reveal', () => {
    it('responds with the bytes once, then nothing', async () => {
      const { id, key } = await uploadSecret(app);

      const first = await app.request(`/s/${id}/reveal`, revealRequest(key));
      const second = await app.request(`/s/${id}/reveal`, revealRequest(key));
      const page = await app.request(`/s/${id}`);

      expect(first.status).toBe(200);
      expect(first.headers.get('content-type')).toBe('application/octet-stream');
      expect(first.headers.get('x-content-type-options')).toBe('nosniff');
      expect(first.headers.get('cache-control')).toContain('no-store');
      await expect(first.text()).resolves.toBe(SECRET);
      expect(second.status).toBe(404);
      await expect(second.text()).resolves.toBe('');
      expect(page.status).toBe(404);
    });

    it('refuses a wrong, malformed, or missing key and leaves the secret revealable', async () => {
      const { id, key } = await uploadSecret(app);

      const wrong = await app.request(`/s/${id}/reveal`, revealRequest(WRONG_KEY));
      const malformed = await app.request(`/s/${id}/reveal`, revealRequest('nope'));
      const missing = await app.request(`/s/${id}/reveal`, {
        headers: { Origin: ORIGIN },
        method: 'POST',
      });
      const right = await app.request(`/s/${id}/reveal`, revealRequest(key));

      expect([wrong.status, malformed.status, missing.status]).toEqual([404, 404, 404]);
      await expect(wrong.text()).resolves.toBe('');
      expect(right.status).toBe(200);
      await expect(right.text()).resolves.toBe(SECRET);
    });

    it('refuses an unknown or malformed id with a bare 404', async () => {
      const unknown = await app.request(
        '/s/AAAAAAAAAAAAAAAAAAAAAA/reveal',
        revealRequest(WRONG_KEY),
      );
      const malformed = await app.request('/s/nope/reveal', revealRequest(WRONG_KEY));

      expect([unknown.status, malformed.status]).toEqual([404, 404]);
    });

    it('reads a body of up to 1024 bytes and refuses a longer one, keeping the secret', async () => {
      const { id, key } = await uploadSecret(app);
      // A form of exactly `size` bytes whose `key` field is the right key.
      const paddedTo = (size: number): RequestInit => {
        const fields = `key=${key}&pad=`;
        return { ...revealRequest(key), body: fields + 'x'.repeat(size - fields.length) };
      };

      const over = await app.request(`/s/${id}/reveal`, paddedTo(1025));
      const atLimit = await app.request(`/s/${id}/reveal`, paddedTo(1024));

      expect(over.status).toBe(404);
      expect(over.headers.get('cache-control')).toContain('no-store');
      await expect(over.text()).resolves.toBe('');
      expect(atLimit.status).toBe(200);
      await expect(atLimit.text()).resolves.toBe(SECRET);
    });

    it('answers a malformed body with the bare refusal and keeps the secret', async () => {
      const { id, key } = await uploadSecret(app);

      const malformed = await app.request(`/s/${id}/reveal`, MALFORMED_MULTIPART);

      expect(malformed.status).toBe(404);
      expect(malformed.headers.get('cache-control')).toContain('no-store');
      await expect(malformed.text()).resolves.toBe('');
      expect((await app.request(`/s/${id}/reveal`, revealRequest(key))).status).toBe(200);
    });
  });

  describe('POST /s/download/:token', () => {
    it('responds with the bytes once to a bare POST, then with a bare 404', async () => {
      const content = Uint8Array.from({ length: 256 }, (_, index) => index);
      const token = await claimToken(content);

      const first = await app.request(`/s/download/${token}`, DOWNLOAD);
      const second = await app.request(`/s/download/${token}`, DOWNLOAD);

      expect(first.status).toBe(200);
      expect(first.headers.get('content-type')).toBe('application/octet-stream');
      expect(first.headers.get('cache-control')).toContain('no-store');
      expect(first.headers.get('x-content-type-options')).toBe('nosniff');
      expect(new Uint8Array(await first.arrayBuffer())).toEqual(content);
      expectBareRefusal(second);
      await expect(second.text()).resolves.toBe('');
    });

    it('refuses an expired, unknown, or malformed token with a bare 404', async () => {
      const expired = await claimToken();
      advance(CLAIM_LIFETIME_SECONDS);

      const responses = await Promise.all(
        [expired, 'A'.repeat(43), 'not-a-token', 'reveal'].map(async (token) =>
          app.request(`/s/download/${token}`, DOWNLOAD),
        ),
      );

      const bodies = await Promise.all(responses.map(async (res) => res.text()));
      for (const res of responses) {
        expectBareRefusal(res);
      }
      expect(bodies).toEqual(['', '', '', '']);
    });

    it('answers no other method, and the token still works afterwards', async () => {
      const token = await claimToken();
      const path = `/s/download/${token}`;
      const methods = ['GET', 'HEAD', 'PUT', 'DELETE', 'PATCH'];

      const responses = await Promise.all(
        methods.map(async (method) => app.request(path, { method })),
      );

      // With auth on, the usual refusals: no session, and no Origin on a
      // write. With it off, the bare 404.
      expect(responses.map((res) => res.status)).toEqual(
        authOn ? [302, 302, 403, 403, 403] : [404, 404, 404, 404, 404],
      );
      for (const res of responses.filter(({ status }) => status === 404)) {
        expectBareRefusal(res);
      }
      expect((await app.request(path, DOWNLOAD)).status).toBe(200);
    });

    it('neither shadows nor is shadowed by the view and reveal routes', async () => {
      const { id, key } = await uploadSecret(app);

      const downloadReveal = await app.request('/s/download/reveal', revealRequest(key));
      const downloadPage = await app.request('/s/download');
      const view = await app.request(`/s/${id}`);
      const reveal = await app.request(`/s/${id}/reveal`, revealRequest(key));

      expectBareRefusal(downloadReveal);
      expect(downloadPage.status).toBe(404);
      await expect(downloadPage.text()).resolves.toContain('Nothing to reveal');
      expect(view.status).toBe(200);
      expect(reveal.status).toBe(200);
    });
  });

  describe('/secrets/new', () => {
    const FIELDS = { expires: '86400', label: 'Deploy token', secret: SECRET };

    async function submit(fields: Record<string, string> = FIELDS, target = app) {
      return target.request('/secrets/new', formRequest(fields, session));
    }

    // The page as a browser loads it, with `cookie` (a create's handle
    // cookie) beside the session, if any.
    async function newSecretPage(cookie?: string) {
      const cookies = [session.Cookie, cookie].filter((value) => value !== undefined).join('; ');
      return app.request('/secrets/new', cookies === '' ? {} : { headers: { Cookie: cookies } });
    }

    async function handleShownAfter(created: Response): Promise<string> {
      const page = await (await newSecretPage(cookiePair(created))).text();
      const handle = HANDLE.exec(page)?.[0];
      if (handle === undefined) {
        throw new Error('no handle shown');
      }
      return handle;
    }

    it('offers a form for a label, the secret, and an expiry of 1 h, 24 h, or 7 d', async () => {
      const res = await newSecretPage();

      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toContain('no-store');
      const body = await res.text();
      expect(body).toMatch(/<form[^>]*action="\/secrets\/new"/u);
      expect(body).toMatch(/<input[^>]*name="label"/u);
      expect(body).toMatch(/<textarea[^>]*name="secret"/u);
      const radios = body.match(/<input[^>]*name="expires"[^>]*>/gu) ?? [];
      expect(radios.map((radio) => /value="(\d+)"/u.exec(radio)?.[1])).toEqual([
        '3600',
        '86400',
        '604800',
      ]);
      expect(radios.map((radio) => radio.includes('type="radio"'))).toEqual([true, true, true]);
      expect(radios.map((radio) => /\bchecked\b/u.test(radio))).toEqual([false, true, false]);
      expect(body).toContain('Seal secret');
      expect(HANDLE.test(body)).toBe(false);
    });

    it('seals the secret and shows its handle once, in a page no cache keeps', async () => {
      const created = await submit({ ...FIELDS, expires: '3600' });

      expect(created.status).toBe(303);
      expect(created.headers.get('location')).toBe('/secrets/new');
      const shown = await newSecretPage(cookiePair(created));
      expect(shown.status).toBe(200);
      expect(shown.headers.get('cache-control')).toContain('no-store');
      expect(shown.headers.get('set-cookie')).toMatch(/Max-Age=0/u);
      const body = await shown.text();
      const handle = HANDLE.exec(body)?.[0] ?? '';
      // Exactly the handle, so selecting or copying it takes nothing else.
      expect(body).toContain(`>${handle}</`);
      expect(body).toContain('Deploy token');
      expect(body).toContain('Copy handle');
      expect(body).toMatch(/Shown once\. Works once, through Muninn’s MCP, until /u);
      expect(body).toMatch(/<a[^>]*href="\/secrets\/new"[^>]*>Create another</u);
      expect(body).not.toContain(SECRET);

      const { id, key } = parseHandle(handle) ?? { id: '', key: '' };
      await expect(secrets.find(id)).resolves.toMatchObject({
        expiresAt: new Date(clock.getTime() + 3600 * 1000).toISOString(),
        label: 'Deploy token',
      });
      const revealed = await secrets.reveal(id, key);
      expect(new TextDecoder().decode(revealed?.content)).toBe(SECRET);
    });

    it('keeps the handle in a minute-long cookie for this page only, out of reach of scripts and other sites', async () => {
      const header = (await submit()).headers.get('set-cookie') ?? '';

      expect(header).toMatch(/Max-Age=60(;|$)/u);
      expect(header).toMatch(/Path=\/secrets\/new(;|$)/u);
      expect(header).toMatch(/HttpOnly/u);
      expect(header).toMatch(/SameSite=Strict/u);
      expect(header).toMatch(/Secure/u);
    });

    it('marks the handle cookie Secure only when the public base URL is HTTPS', async () => {
      process.env.MUNINN_PUBLIC_BASE_URL = 'http://muninn.example';

      const header = (await submit()).headers.get('set-cookie') ?? '';

      expect(header).toMatch(/SameSite=Strict/u);
      expect(header).not.toMatch(/Secure/u);
    });

    it('shows no handle and creates nothing when the page is refreshed', async () => {
      const created = await submit();
      await newSecretPage(cookiePair(created));

      const refreshed = await newSecretPage();

      expect(refreshed.status).toBe(200);
      expect(HANDLE.test(await refreshed.text())).toBe(false);
      expect(creates()).toBe(1);
    });

    it('shows no handle from a cookie that names no pending secret', async () => {
      const created = await submit();
      const cookie = cookiePair(created);
      const handle = await handleShownAfter(created);
      const { id, key } = parseHandle(handle) ?? { id: '', key: '' };
      await secrets.reveal(id, key);
      const name = cookie.split('=')[0]!;

      const pages = await Promise.all(
        [cookie, `${name}=x`, `${name}=${handle.slice(0, -1)}`].map(async (value) =>
          newSecretPage(value),
        ),
      );

      const bodies = await Promise.all(pages.map(async (page) => page.text()));
      expect(pages.map((page) => page.status)).toEqual([200, 200, 200]);
      expect(bodies.filter((body) => HANDLE.test(body))).toEqual([]);
    });

    it('stores a secret typed with CRLF line breaks, as browsers send a textarea, with LF', async () => {
      const handle = await handleShownAfter(
        await submit({ ...FIELDS, secret: 'line one\r\nline two\r\n' }),
      );

      const { id, key } = parseHandle(handle) ?? { id: '', key: '' };
      const revealed = await secrets.reveal(id, key);
      expect(new TextDecoder().decode(revealed?.content)).toBe('line one\nline two\n');
    });

    it('refuses invalid input with the form and a message, never echoing the secret', async () => {
      const cases: [Record<string, string>, RegExp][] = [
        [{ ...FIELDS, label: '  ' }, /label/iu],
        [{ ...FIELDS, label: 'x'.repeat(101) }, /label/iu],
        [{ ...FIELDS, label: 'Deploy\u202Etoken' }, /label/iu],
        [{ ...FIELDS, secret: '' }, /secret/iu],
        [{ ...FIELDS, secret: `${SECRET}${'x'.repeat(MAX_SECRET_BYTES)}` }, /64 KiB/u],
        [{ ...FIELDS, expires: '60' }, /expire/iu],
        [{ ...FIELDS, expires: '7200' }, /expire/iu],
        [{ label: FIELDS.label, secret: SECRET }, /expire/iu],
      ];

      const responses = await Promise.all(cases.map(async ([fields]) => submit(fields)));
      const bodies = await Promise.all(responses.map(async (res) => res.text()));

      for (const [index, res] of responses.entries()) {
        const body = bodies[index]!;
        expect([index, res.status]).toEqual([index, 400]);
        expect(res.headers.get('set-cookie')).toBeNull();
        expect(res.headers.get('cache-control')).toContain('no-store');
        expect(body).toMatch(/<form[^>]*action="\/secrets\/new"/u);
        expect(/role="alert"[^>]*>([^<]*)</u.exec(body)?.[1]).toMatch(cases[index]![1]);
        expect(body).not.toContain(SECRET);
      }
    });

    it('refuses a body far over the limit with the form and no echo', async () => {
      const res = await submit({
        ...FIELDS,
        secret: `${SECRET}${'x'.repeat(7 * MAX_SECRET_BYTES)}`,
      });

      expect(res.status).toBe(413);
      expect(res.headers.get('set-cookie')).toBeNull();
      const body = await res.text();
      expect(body).toMatch(/<form[^>]*action="\/secrets\/new"/u);
      expect(body).toMatch(/64 KiB/u);
      expect(body).not.toContain(SECRET);
      expect(creates()).toBe(0);
    });

    it('reports a full store on the form', async () => {
      const full = appWith({
        ...secrets,
        create: async () => {
          throw new SecretLimitError(SECRET_LIMIT);
        },
      });

      const res = await submit(FIELDS, full);

      expect(res.status).toBe(503);
      expect(res.headers.get('set-cookie')).toBeNull();
      const body = await res.text();
      expect(body).toMatch(/unread secrets/u);
      expect(body).not.toContain(SECRET);
    });
  });

  it('links to the new-secret page from the gallery header', async () => {
    const res = await app.request('/', { headers: session });

    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toMatch(/<a[^>]*href="\/secrets\/new"[^>]*>New secret</u);
  });

  it('marks even a failed response from every secret route as no-store', async () => {
    const { id, key } = await uploadSecret(app);
    const { uploadToken } = await secrets.createUpload({ label: 'Broken' });
    const broken = {
      ...secrets,
      download: failStore,
      find: failStore,
      reveal: failStore,
      upload: failStore,
    };
    const brokenApp = createApp({ artifacts, mcp: artifacts, secrets: broken });

    const responses = await Promise.all([
      brokenApp.request(`/s/upload/${uploadToken}`, uploadRequest(SECRET)),
      brokenApp.request(`/s/${id}`),
      brokenApp.request(`/s/${id}/reveal`, revealRequest(key)),
      brokenApp.request(`/s/download/${'A'.repeat(43)}`, DOWNLOAD),
    ]);

    expect(responses.map((res) => res.status)).toEqual([500, 500, 500, 500]);
    for (const res of responses) {
      expect(res.headers.get('cache-control')).toContain('no-store');
    }
  });
});

describe('secret routes with an owner password', () => {
  let app: TestApp;
  let auth: ReturnType<typeof createOwnerAuth>;

  beforeEach(async () => {
    auth = createOwnerAuth({
      password: PASSWORD,
      store: await SqliteOwnerAuthStore.open(join(dataDir, 'artifacts.db')),
    });
    app = createApp({ artifacts, auth, mcp: artifacts, secrets });
  });

  it('refuses a reveal from another origin, or with none, and keeps the secret', async () => {
    const { id, key } = await uploadSecret(app);

    const foreign = await app.request(
      `/s/${id}/reveal`,
      revealRequest(key, 'https://evil.example'),
    );
    const sandboxed = await app.request(`/s/${id}/reveal`, revealRequest(key, 'null'));
    const none = await app.request(`/s/${id}/reveal`, revealRequest(key, null));

    expect([foreign.status, sandboxed.status, none.status]).toEqual([403, 403, 403]);
    for (const refusal of [foreign, sandboxed, none]) {
      expect(refusal.headers.get('cache-control')).toBe('no-store');
    }
    expect((await app.request(`/s/${id}/reveal`, revealRequest(key))).status).toBe(200);
  });

  it('lets a download through with no session and no Origin, or a foreign one', async () => {
    const tokens = await Promise.all([claimToken(), claimToken(), claimToken()]);
    const inits: RequestInit[] = [
      DOWNLOAD,
      { headers: { Origin: 'https://evil.example' }, method: 'POST' },
      { headers: { Origin: 'null' }, method: 'POST' },
    ];

    const responses = await Promise.all(
      tokens.map(async (token, index) => app.request(`/s/download/${token}`, inits[index])),
    );

    expect(responses.map((res) => res.status)).toEqual([200, 200, 200]);
    for (const res of responses) {
      expect(res.headers.get('cache-control')).toContain('no-store');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    }
  });

  it('keeps the new-secret page behind the session and the Origin rule', async () => {
    const counting = countingCreates(secrets);
    const guarded = createApp({ artifacts, auth, mcp: artifacts, secrets: counting.service });
    const cookie = await logIn(guarded);
    const fields = { expires: '86400', label: 'Deploy token', secret: SECRET };
    const post = (headers: Record<string, string>) => formRequest(fields, headers);
    const noOrigin = (headers: Record<string, string>): RequestInit => ({
      body: new URLSearchParams(fields).toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
      method: 'POST',
    });

    const page = await guarded.request('/secrets/new');
    const refusals = await Promise.all([
      guarded.request('/secrets/new', post({})),
      guarded.request('/secrets/new', noOrigin({})),
      guarded.request('/secrets/new', noOrigin({ Cookie: cookie })),
      guarded.request('/secrets/new', post({ Cookie: cookie, Origin: 'https://evil.example' })),
      guarded.request('/secrets/new', post({ Cookie: cookie, Origin: 'null' })),
    ]);

    expect(page.status).toBe(302);
    expect(page.headers.get('location')).toBe('/login?next=%2Fsecrets%2Fnew');
    expect(refusals.map((res) => res.status)).toEqual([401, 403, 403, 403, 403]);
    expect(counting.count()).toBe(0);
    const created = await guarded.request('/secrets/new', post({ Cookie: cookie }));
    expect(created.status).toBe(303);
    expect(counting.count()).toBe(1);
  });

  it('answers HEAD for a view link without a session, as it does GET', async () => {
    const { id } = await uploadSecret(app);

    const pending = await app.request(`/s/${id}`, { method: 'HEAD' });
    const unknown = await app.request('/s/AAAAAAAAAAAAAAAAAAAAAA', { method: 'HEAD' });

    expect([pending.status, unknown.status]).toEqual([200, 404]);
    expect(pending.headers.get('content-security-policy')).toBe(SECRET_PAGE_CSP);
  });

  it('applies the usual refusal to other methods on the exempt paths', async () => {
    const { id } = await uploadSecret(app);
    const { uploadToken } = await secrets.createUpload({ label: 'Probe' });
    const upload = `/s/upload/${uploadToken}`;
    const view = `/s/${id}`;
    const download = `/s/download/${await claimToken()}`;
    const withOrigin = { headers: { Origin: ORIGIN } };

    const probes: [string, string, RequestInit, number][] = [
      // No Origin: refused before anything else.
      [upload, 'PUT', {}, 403],
      [upload, 'DELETE', {}, 403],
      [upload, 'PATCH', {}, 403],
      [view, 'PUT', {}, 403],
      [view, 'DELETE', {}, 403],
      [download, 'PUT', {}, 403],
      [download, 'DELETE', {}, 403],
      [download, 'PATCH', {}, 403],
      // Own Origin: still needs a session.
      [upload, 'PUT', withOrigin, 401],
      [upload, 'DELETE', withOrigin, 401],
      [upload, 'PATCH', withOrigin, 401],
      [view, 'PUT', withOrigin, 401],
      [view, 'DELETE', withOrigin, 401],
      [download, 'PUT', withOrigin, 401],
      [download, 'DELETE', withOrigin, 401],
      [download, 'PATCH', withOrigin, 401],
    ];
    const responses = await Promise.all(
      probes.map(async ([path, method, init]) => app.request(path, { ...init, method })),
    );

    expect(
      responses.map((res, index) => `${probes[index]![1]} ${probes[index]![0]} ${res.status}`),
    ).toEqual(probes.map(([path, method, , status]) => `${method} ${path} ${status}`));
    // The guard's refusals under /s/ are kept by no cache either.
    for (const res of responses) {
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
    expect((await app.request(upload, uploadRequest(SECRET))).status).toBe(201);
    expect((await app.request(download, DOWNLOAD)).status).toBe(200);
  });

  it('keeps a secret page’s own policy while other pages refuse only frames', async () => {
    const { id } = await uploadSecret(app);
    const login = await app.request('/login', {
      body: new URLSearchParams({ password: PASSWORD }).toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: ORIGIN },
      method: 'POST',
    });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;

    const home = await app.request('/', { headers: { Cookie: cookie } });
    const secretPage = await app.request(`/s/${id}`, { headers: { Cookie: cookie } });

    expect(home.status).toBe(200);
    expect(home.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
    expect(home.headers.get('x-frame-options')).toBe('DENY');
    expect(secretPage.status).toBe(200);
    expect(secretPage.headers.get('content-security-policy')).toBe(SECRET_PAGE_CSP);
    expect(secretPage.headers.get('x-frame-options')).toBe('DENY');
  });

  it('opens no other route to a request without a session', async () => {
    const { id } = await uploadSecret(app);
    const { uploadToken } = await secrets.createUpload({ label: 'Probe' });
    const token = await claimToken();

    const probes: [string, RequestInit, number][] = [
      // Other methods on the exempt paths.
      [`/s/upload/${uploadToken}`, {}, 302],
      [`/s/download/${token}`, {}, 302],
      [`/s/${id}`, { headers: { Origin: ORIGIN }, method: 'POST' }, 401],
      [`/s/${id}/reveal`, {}, 302],
      // Neighbouring paths.
      [`/s/upload/${uploadToken}/x`, uploadRequest(SECRET), 403],
      [`/s/${id}/reveal/x`, revealRequest('x'), 401],
      [`/s/${id}/x`, {}, 302],
      [`/s/download/${token}/x`, DOWNLOAD, 403],
      ['/s/download', DOWNLOAD, 403],
      ['/s/download/', DOWNLOAD, 403],
      ['/s/', {}, 302],
      ['/s', {}, 302],
      // Paths that only look like an exempt one before routing.
      [`/s/upload/..%2F..%2Fkeys`, uploadRequest(SECRET), 403],
      [`/s/download/..%2F..%2Fkeys`, DOWNLOAD, 403],
      ['/secrets/new', DOWNLOAD, 403],
      [`/s/a.b/reveal`, revealRequest('x'), 401],
      ['/keys', revealRequest('x'), 401],
      ['/mcp', uploadRequest('{}'), 401],
      ['/', {}, 302],
    ];
    const responses = await Promise.all(
      probes.map(async ([path, init]) => app.request(path, init)),
    );

    expect(responses.map((res, index) => [probes[index]![0], res.status])).toEqual(
      probes.map(([path, , status]) => [path, status]),
    );
    expect((await app.request(`/s/download/${token}`, DOWNLOAD)).status).toBe(200);
  });
});

describe('secret routes without a secret service', () => {
  it('are absent', async () => {
    const app = createApp({ artifacts, mcp: artifacts });

    expect((await app.request('/s/AAAAAAAAAAAAAAAAAAAAAA')).status).toBe(404);
    expect((await app.request(`/s/upload/${'A'.repeat(43)}`, uploadRequest(SECRET))).status).toBe(
      404,
    );
    expect(
      (await app.request('/s/AAAAAAAAAAAAAAAAAAAAAA/reveal', revealRequest(WRONG_KEY))).status,
    ).toBe(404);
    expect((await app.request(`/s/download/${'A'.repeat(43)}`, DOWNLOAD)).status).toBe(404);
    expect((await app.request('/secrets/new')).status).toBe(404);
    expect(
      (
        await app.request(
          '/secrets/new',
          formRequest({ expires: '86400', label: 'L', secret: SECRET }, {}),
        )
      ).status,
    ).toBe(404);
  });
});
