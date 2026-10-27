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
import { createSecretService, MAX_SECRET_BYTES, UPLOAD_SLOT_LIFETIME_SECONDS } from './service.js';
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

  beforeEach(async () => {
    const auth = authOn
      ? createOwnerAuth({
          password: PASSWORD,
          store: await SqliteOwnerAuthStore.open(join(dataDir, 'artifacts.db')),
        })
      : undefined;
    app = createApp({
      artifacts,
      ...(auth === undefined ? {} : { auth }),
      mcp: artifacts,
      secrets,
    });
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

  it('marks even a failed response from every secret route as no-store', async () => {
    const { id, key } = await uploadSecret(app);
    const { uploadToken } = await secrets.createUpload({ label: 'Broken' });
    const broken = { ...secrets, find: failStore, reveal: failStore, upload: failStore };
    const brokenApp = createApp({ artifacts, mcp: artifacts, secrets: broken });

    const responses = await Promise.all([
      brokenApp.request(`/s/upload/${uploadToken}`, uploadRequest(SECRET)),
      brokenApp.request(`/s/${id}`),
      brokenApp.request(`/s/${id}/reveal`, revealRequest(key)),
    ]);

    expect(responses.map((res) => res.status)).toEqual([500, 500, 500]);
    for (const res of responses) {
      expect(res.headers.get('cache-control')).toContain('no-store');
    }
  });
});

describe('secret routes with an owner password', () => {
  let app: TestApp;

  beforeEach(async () => {
    const auth = createOwnerAuth({
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
    const withOrigin = { headers: { Origin: ORIGIN } };

    const probes: [string, string, RequestInit, number][] = [
      // No Origin: refused before anything else.
      [upload, 'PUT', {}, 403],
      [upload, 'DELETE', {}, 403],
      [upload, 'PATCH', {}, 403],
      [view, 'PUT', {}, 403],
      [view, 'DELETE', {}, 403],
      // Own Origin: still needs a session.
      [upload, 'PUT', withOrigin, 401],
      [upload, 'DELETE', withOrigin, 401],
      [upload, 'PATCH', withOrigin, 401],
      [view, 'PUT', withOrigin, 401],
      [view, 'DELETE', withOrigin, 401],
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

    const probes: [string, RequestInit, number][] = [
      // Other methods on the exempt paths.
      [`/s/upload/${uploadToken}`, {}, 302],
      [`/s/${id}`, { headers: { Origin: ORIGIN }, method: 'POST' }, 401],
      [`/s/${id}/reveal`, {}, 302],
      // Neighbouring paths.
      [`/s/upload/${uploadToken}/x`, uploadRequest(SECRET), 403],
      [`/s/${id}/reveal/x`, revealRequest('x'), 401],
      [`/s/${id}/x`, {}, 302],
      ['/s/', {}, 302],
      ['/s', {}, 302],
      // Paths that only look like an exempt one before routing.
      [`/s/upload/..%2F..%2Fkeys`, uploadRequest(SECRET), 403],
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
  });
});
