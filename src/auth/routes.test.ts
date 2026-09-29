import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';

import { createApp } from '../app.js';
import { SqliteOwnerAuthStore } from '../data/sqlite-owner-auth-store.js';
import type { ArtifactService } from '../data/store.js';
import { createByteNativeArtifactService } from '../data/store.js';
import { createOwnerAuth, LOGIN_ATTEMPT_LIMIT, SESSION_LIFETIME_SECONDS } from './owner-auth.js';

const PASSWORD = 'correct horse battery staple';
// app.request() resolves paths against http://localhost.
const ORIGIN = 'http://localhost';

let dataDir: string;
let service: ArtifactService;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'artifacts-auth-routes-'));
  service = await createByteNativeArtifactService({
    databasePath: join(dataDir, 'artifacts.db'),
    filesDir: join(dataDir, 'artifacts'),
  });
});

afterEach(async () => {
  await rm(dataDir, { force: true, recursive: true });
});

function createText(content: string) {
  return service.createArtifact({
    content: new TextEncoder().encode(content),
    description: 'Auth fixture',
    mediaType: 'text/plain',
    project: 'auth',
    title: 'Private notes',
  });
}

function loginRequest(
  password: string,
  { headers = { Origin: ORIGIN }, next }: { headers?: Record<string, string>; next?: string } = {},
): RequestInit {
  const form = new URLSearchParams({ password });
  if (next !== undefined) {
    form.set('next', next);
  }
  return {
    body: form.toString(),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    method: 'POST',
  };
}

function formPost(fields: Record<string, string>, headers: Record<string, string>): RequestInit {
  return {
    body: new URLSearchParams(fields).toString(),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: ORIGIN, ...headers },
    method: 'POST',
  };
}

// An MCP tool call as an agent sends it: no Origin, JSON body.
function listArtifactsCall(headers: Record<string, string> = {}): RequestInit {
  return {
    body: JSON.stringify({
      id: 1,
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { arguments: {}, name: 'list_artifacts' },
    }),
    headers: {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      ...headers,
    },
    method: 'POST',
  };
}

const SHOWN_KEY = /art_[\w-]{43}/u;

// The `name=value` pair a browser would send back from a Set-Cookie header.
function sessionCookie(res: Response): string {
  const header = res.headers.get('set-cookie');
  if (header === null) {
    throw new Error('response set no cookie');
  }
  return header.split(';')[0]!;
}

describe('with no owner password', () => {
  let testApp: ReturnType<typeof createApp>;

  beforeEach(() => {
    testApp = createApp({ artifacts: service, mcp: service });
  });

  it('serves pages and artifacts without a session, as before', async () => {
    const artifact = await createText('open to the trusted network');

    const home = await testApp.request('/');
    const page = await testApp.request(`/a/${artifact.id}`);

    expect(home.status).toBe(200);
    const homeBody = await home.text();
    expect(homeBody).not.toContain('action="/logout"');
    expect(homeBody).not.toContain('href="/keys"');
    expect(page.status).toBe(200);
    await expect(page.text()).resolves.toContain('open to the trusted network');
    expect(page.headers.get('set-cookie')).toBeNull();
  });

  it('has no login, logout, or API key routes', async () => {
    expect((await testApp.request('/login')).status).toBe(404);
    expect((await testApp.request('/login', loginRequest(PASSWORD))).status).toBe(404);
    expect(
      (await testApp.request('/logout', { headers: { Origin: ORIGIN }, method: 'POST' })).status,
    ).toBe(404);
    expect((await testApp.request('/keys')).status).toBe(404);
    expect((await testApp.request('/keys', formPost({ name: 'agent' }, {}))).status).toBe(404);
    expect((await testApp.request('/keys/any/revoke', formPost({}, {}))).status).toBe(404);
  });

  it('serves /mcp without a key', async () => {
    const res = await testApp.request('/mcp', listArtifactsCall());

    expect(res.status).toBe(200);
  });
});

describe('with an owner password', () => {
  let testApp: ReturnType<typeof createApp>;
  const originalBaseUrl = process.env.ARTIFACTS_PUBLIC_BASE_URL;

  beforeEach(async () => {
    delete process.env.ARTIFACTS_PUBLIC_BASE_URL;
    const auth = createOwnerAuth({
      password: PASSWORD,
      store: await SqliteOwnerAuthStore.open(join(dataDir, 'artifacts.db')),
    });
    testApp = createApp({ artifacts: service, auth, mcp: service });
  });

  afterEach(() => {
    if (originalBaseUrl === undefined) {
      delete process.env.ARTIFACTS_PUBLIC_BASE_URL;
    } else {
      process.env.ARTIFACTS_PUBLIC_BASE_URL = originalBaseUrl;
    }
  });

  async function logIn(): Promise<string> {
    const res = await testApp.request('/login', loginRequest(PASSWORD));
    expect(res.status).toBe(303);
    return sessionCookie(res);
  }

  it('sends a page request without a session to the login form, keeping its path', async () => {
    const res = await testApp.request('/p/auth?kind=txt');

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(
      `/login?next=${encodeURIComponent('/p/auth?kind=txt')}`,
    );
  });

  it('requires a session for artifact content and thumbnails', async () => {
    const artifact = await createText('owner eyes only');

    const paths = [`/a/${artifact.id}`, `/a/${artifact.id}/thumb`, '/a/missing'];
    const responses = await Promise.all(paths.map(async (path) => testApp.request(path)));

    expect(responses.map((res) => res.status)).toEqual([302, 302, 302]);
    const bodies = await Promise.all(responses.map((res) => res.text()));
    expect(bodies.join('')).not.toContain('owner eyes only');
  });

  it('refuses a state-changing request without a session', async () => {
    const res = await testApp.request('/logout', { headers: { Origin: ORIGIN }, method: 'POST' });

    expect(res.status).toBe(401);
  });

  // Creates a key through the page, as the owner would, and returns what
  // the page showed.
  async function createKey(cookie: string, name = 'laptop agent'): Promise<string> {
    const res = await testApp.request('/keys', formPost({ name }, { Cookie: cookie }));
    expect(res.status).toBe(200);
    const shown = SHOWN_KEY.exec(await res.text());
    if (shown === null) {
      throw new Error('the key page showed no key');
    }
    return shown[0];
  }

  it('sends a request for the key page without a session to the login form', async () => {
    const res = await testApp.request('/keys');

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login?next=%2Fkeys');
  });

  it('refuses to create a key without a session', async () => {
    const res = await testApp.request('/keys', formPost({ name: 'agent' }, {}));

    expect(res.status).toBe(401);
  });

  it('refuses to create a key from another origin', async () => {
    const cookie = await logIn();

    const res = await testApp.request(
      '/keys',
      formPost({ name: 'agent' }, { Cookie: cookie, Origin: 'https://evil.example' }),
    );

    expect(res.status).toBe(403);
  });

  it('shows a new key once, in a response no cache keeps', async () => {
    const cookie = await logIn();

    const res = await testApp.request(
      '/keys',
      formPost({ name: 'laptop agent' }, { Cookie: cookie }),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('no-store');
    const body = await res.text();
    const key = SHOWN_KEY.exec(body)?.[0];
    expect(key).toBeDefined();

    const later = await (await testApp.request('/keys', { headers: { Cookie: cookie } })).text();
    expect(later).toContain('laptop agent');
    expect(later).not.toContain(key);
  });

  it('refuses a key without a name', async () => {
    const cookie = await logIn();

    const res = await testApp.request('/keys', formPost({ name: '  ' }, { Cookie: cookie }));

    expect(res.status).toBe(400);
    expect(SHOWN_KEY.test(await res.text())).toBe(false);
  });

  it('serves /mcp to a request with a key', async () => {
    const key = await createKey(await logIn());

    const res = await testApp.request(
      '/mcp',
      listArtifactsCall({ Authorization: `Bearer ${key}` }),
    );

    expect(res.status).toBe(200);
  });

  it.each([
    ['no Authorization header', {}],
    ['a wrong key', { Authorization: 'Bearer art_wrong' }],
    ['a key in another scheme', { Authorization: 'Basic art_wrong' }],
  ])('refuses /mcp with %s', async (_label, headers) => {
    await createKey(await logIn());

    const res = await testApp.request('/mcp', listArtifactsCall(headers));

    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
  });

  it('refuses /mcp to a session without a key', async () => {
    const cookie = await logIn();

    const res = await testApp.request('/mcp', listArtifactsCall({ Cookie: cookie }));

    expect(res.status).toBe(401);
  });

  it('refuses /mcp with a revoked key and lists the key no more', async () => {
    const cookie = await logIn();
    const key = await createKey(cookie, 'revoke me');
    const page = await (await testApp.request('/keys', { headers: { Cookie: cookie } })).text();
    const action = /action="(\/keys\/[\w-]+\/revoke)"/u.exec(page)?.[1];
    expect(action).toBeDefined();

    const revoked = await testApp.request(action!, formPost({}, { Cookie: cookie }));

    expect(revoked.status).toBe(303);
    expect(revoked.headers.get('location')).toBe('/keys');
    const res = await testApp.request(
      '/mcp',
      listArtifactsCall({ Authorization: `Bearer ${key}` }),
    );
    expect(res.status).toBe(401);
    const after = await (await testApp.request('/keys', { headers: { Cookie: cookie } })).text();
    expect(after).not.toContain('revoke me');
  });

  it('refuses to revoke a key from another origin', async () => {
    const cookie = await logIn();
    const key = await createKey(cookie);
    const page = await (await testApp.request('/keys', { headers: { Cookie: cookie } })).text();
    const action = /action="(\/keys\/[\w-]+\/revoke)"/u.exec(page)![1]!;

    const res = await testApp.request(
      action,
      formPost({}, { Cookie: cookie, Origin: 'https://evil.example' }),
    );

    expect(res.status).toBe(403);
    const call = await testApp.request(
      '/mcp',
      listArtifactsCall({ Authorization: `Bearer ${key}` }),
    );
    expect(call.status).toBe(200);
  });

  it('keeps /mcp closed at a percent-encoded path, even with a session', async () => {
    const cookie = await logIn();

    const res = await testApp.request('/%6dcp', {
      body: '{}',
      headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: ORIGIN },
      method: 'POST',
    });

    expect(res.status).toBe(401);
  });

  it('serves the login form', async () => {
    const res = await testApp.request('/login?next=%2Fa%2Fabc');

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('action="/login"');
    expect(body).toContain('type="password"');
    expect(body).toContain('value="/a/abc"');
  });

  it('logs in with the password and sets an HttpOnly, SameSite=Lax session cookie', async () => {
    const artifact = await createText('owner eyes only');

    const res = await testApp.request(
      '/login',
      loginRequest(PASSWORD, { next: `/a/${artifact.id}` }),
    );

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`/a/${artifact.id}`);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/^artifacts_session=[\w-]{43};/u);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).toContain(`Max-Age=${String(SESSION_LIFETIME_SECONDS)}`);
    expect(setCookie).not.toContain('Secure');

    const page = await testApp.request(`/a/${artifact.id}`, {
      headers: { Cookie: sessionCookie(res) },
    });
    expect(page.status).toBe(200);
    await expect(page.text()).resolves.toContain('owner eyes only');
  });

  it('marks the session cookie Secure when the public base URL is https', async () => {
    process.env.ARTIFACTS_PUBLIC_BASE_URL = 'https://artifacts.example';

    const res = await testApp.request(
      '/login',
      loginRequest(PASSWORD, { headers: { Origin: 'https://artifacts.example' } }),
    );

    expect(res.status).toBe(303);
    expect(res.headers.get('set-cookie')).toContain('Secure');
  });

  it('rejects a wrong password without a cookie', async () => {
    const res = await testApp.request('/login', loginRequest('wrong'));

    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();
    await expect(res.text()).resolves.toContain('Incorrect password');
  });

  it.each([
    ['missing', {}],
    ['foreign', { Origin: 'https://evil.example' }],
    ['null', { Origin: 'null' }],
  ])('rejects a login post with a %s Origin', async (_label, headers) => {
    const res = await testApp.request('/login', loginRequest(PASSWORD, { headers }));

    expect(res.status).toBe(403);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  // The last four only become `//evil.example` once dot segments resolve.
  const offSiteNextPaths = [
    '//evil.example/',
    'https://evil.example/',
    String.raw`/\evil.example`,
    'relative',
    '/.//evil.example',
    '/%2e//evil.example',
    '/a/..//evil.example',
    String.raw`/./\evil.example`,
  ];

  it.each(offSiteNextPaths)(
    'returns to the home page instead of the off-site next %j',
    async (next) => {
      const res = await testApp.request('/login', loginRequest(PASSWORD, { next }));

      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe('/');
    },
  );

  it.each(offSiteNextPaths)(
    'sends a signed-in owner home instead of the off-site next %j',
    async (next) => {
      const cookie = await logIn();

      const res = await testApp.request(`/login?next=${encodeURIComponent(next)}`, {
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/');
    },
  );

  it('rate limits login attempts with 429 and Retry-After', async () => {
    await Promise.all(
      Array.from({ length: LOGIN_ATTEMPT_LIMIT }, async () =>
        testApp.request('/login', loginRequest('wrong')),
      ),
    );

    const res = await testApp.request('/login', loginRequest(PASSWORD));

    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('sends a signed-in owner from the login form to the next page', async () => {
    const cookie = await logIn();

    const res = await testApp.request('/login?next=%2Fp%2Fauth', { headers: { Cookie: cookie } });

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/p/auth');
  });

  it('marks pages served to a session private and offers a logout form', async () => {
    const cookie = await logIn();

    const res = await testApp.request('/', { headers: { Cookie: cookie } });

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toMatch(/^private\b/u);
    const body = await res.text();
    expect(body).toContain('action="/logout"');
    expect(body).toContain('href="/keys"');
  });

  it('keeps an artifact response revalidatable while marking it private', async () => {
    const artifact = await service.createArtifact({
      content: Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
      description: 'Auth fixture',
      filename: 'pixel.png',
      mediaType: 'image/png',
      project: 'auth',
      title: 'Pixel',
    });
    const cookie = await logIn();

    const res = await testApp.request(`/a/${artifact.id}`, { headers: { Cookie: cookie } });

    expect(res.headers.get('cache-control')).toBe('private, no-cache');
  });

  it('ends the session on logout', async () => {
    const cookie = await logIn();

    const res = await testApp.request('/logout', {
      headers: { Cookie: cookie, Origin: ORIGIN },
      method: 'POST',
    });

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/login');
    expect(res.headers.get('set-cookie')).toMatch(/^artifacts_session=;.*Max-Age=0/u);
    expect((await testApp.request('/', { headers: { Cookie: cookie } })).status).toBe(302);
  });

  it('refuses a logout post from another origin', async () => {
    const cookie = await logIn();

    const res = await testApp.request('/logout', {
      headers: { Cookie: cookie, Origin: 'https://evil.example' },
      method: 'POST',
    });

    expect(res.status).toBe(403);
    expect((await testApp.request('/', { headers: { Cookie: cookie } })).status).toBe(200);
  });

  it('serves icons without a session so the login page can use them', async () => {
    const paths = ['/favicon.svg', '/favicon.ico', '/apple-touch-icon.png', '/assets/app.css'];
    const responses = await Promise.all(paths.map(async (path) => testApp.request(path)));

    expect(responses.map((res) => res.status)).not.toContain(302);
  });
});
