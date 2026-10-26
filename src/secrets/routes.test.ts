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
      expect(atLimit.status).toBe(201);
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
        expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
        expect(res.headers.get('content-security-policy')).toContain("script-src 'self'");
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
    expect((await app.request(`/s/${id}/reveal`, revealRequest(key))).status).toBe(200);
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
