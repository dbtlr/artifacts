import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';

import { serve } from '@hono/node-server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

import { createApp } from '../app.js';
import { SqliteOwnerAuthStore } from '../data/sqlite-owner-auth-store.js';
import type { ArtifactService } from '../data/store.js';
import { createByteNativeArtifactService } from '../data/store.js';
import { createThumbnailQueue } from '../thumbnails/queue.js';
import { buildArtifactUrl } from '../urls.js';
import { createOwnerAuth, LOGIN_ATTEMPT_LIMIT, SESSION_LIFETIME_SECONDS } from './owner-auth.js';
import type { OwnerAuth } from './owner-auth.js';
import { SIGNED_URL_LIFETIME_SECONDS } from './signed-urls.js';

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

// PNG signature bytes, which is all the service checks for an image.
const PNG = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2]);

function createImage() {
  return service.createArtifact({
    content: PNG,
    description: 'Embedded image',
    filename: 'chart.png',
    mediaType: 'image/png',
    project: 'auth',
    title: 'Chart',
  });
}

function createHtml(content: string) {
  return service.createArtifact({
    content: new TextEncoder().encode(content),
    description: 'Page with embeds',
    mediaType: 'text/html',
    project: 'auth',
    title: 'Page',
  });
}

// The src attribute values of a page, as the browser reads them.
function sources(html: string): string[] {
  return [...html.matchAll(/src="([^"]*)"/gu)].map(([, value]) => value!.replaceAll('&amp;', '&'));
}

// The path and query of a URL, which is what app.request() routes on.
function pathOf(url: string): string {
  const parsed = new URL(url, ORIGIN);
  return `${parsed.pathname}${parsed.search}`;
}

const SIGNED_EMBED = String.raw`\?expires=\d+&signature=[\w-]+`;

const SHOWN_KEY = /art_[\w-]{43}/u;

// The `name=value` pair a browser would send back from a Set-Cookie header.
function cookiePair(res: Response): string {
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
    expect((await testApp.request('/keys/revoke-all', formPost({}, {}))).status).toBe(404);
  });

  it('serves an HTML artifact’s embedded URLs unchanged', async () => {
    const image = await createImage();
    const page = `<img src="${buildArtifactUrl(image.id)}"><img src="/a/${image.id}">`;
    const html = await createHtml(page);

    const res = await testApp.request(`/a/${html.id}`);

    await expect(res.text()).resolves.toBe(page);
  });

  it('serves /mcp without a key', async () => {
    const res = await testApp.request('/mcp', listArtifactsCall());

    expect(res.status).toBe(200);
  });
});

describe('with an owner password', () => {
  let auth: OwnerAuth;
  let testApp: ReturnType<typeof createApp>;
  const originalBaseUrl = process.env.ARTIFACTS_PUBLIC_BASE_URL;

  beforeEach(async () => {
    delete process.env.ARTIFACTS_PUBLIC_BASE_URL;
    auth = createOwnerAuth({
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
    return cookiePair(res);
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

  // Submits the create form as a browser does: the POST, then the GET its
  // redirect asks for, carrying the cookie the POST set. Resolves the page
  // the browser lands on.
  async function submitKeyForm(cookie: string, name: string): Promise<Response> {
    const created = await testApp.request('/keys', formPost({ name }, { Cookie: cookie }));
    expect(created.status).toBe(303);
    expect(created.headers.get('location')).toBe('/keys');
    return testApp.request('/keys', {
      headers: { Cookie: `${cookie}; ${cookiePair(created)}` },
    });
  }

  async function keysPage(cookie: string): Promise<string> {
    return (await testApp.request('/keys', { headers: { Cookie: cookie } })).text();
  }

  // Creates a key through the page, as the owner would, and returns what
  // the page showed.
  async function createKey(cookie: string, name = 'laptop agent'): Promise<string> {
    const res = await submitKeyForm(cookie, name);
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

  it('shows a new key once, in a response no cache keeps, and never in a URL', async () => {
    const cookie = await logIn();

    const res = await submitKeyForm(cookie, 'laptop agent');

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(res.headers.get('set-cookie')).toMatch(/Max-Age=0/u);
    const body = await res.text();
    const key = SHOWN_KEY.exec(body)?.[0];
    expect(key).toBeDefined();

    const later = await keysPage(cookie);
    expect(later).toContain('laptop agent');
    expect(later).not.toContain(key);
  });

  it('creates no second key when the page is refreshed after creating one', async () => {
    const cookie = await logIn();
    const created = await testApp.request(
      '/keys',
      formPost({ name: 'laptop agent' }, { Cookie: cookie }),
    );
    const newKeyCookie = cookiePair(created);

    // A refresh repeats the GET the redirect led to, not the POST.
    await testApp.request('/keys', { headers: { Cookie: `${cookie}; ${newKeyCookie}` } });
    const refreshed = await keysPage(cookie);

    await expect(auth.listApiKeys()).resolves.toHaveLength(1);
    expect(SHOWN_KEY.test(refreshed)).toBe(false);
  });

  it('does not show a new key that was revoked before the page loaded', async () => {
    const cookie = await logIn();
    const created = await testApp.request(
      '/keys',
      formPost({ name: 'laptop agent' }, { Cookie: cookie }),
    );
    await auth.revokeAllApiKeys();

    const page = await testApp.request('/keys', {
      headers: { Cookie: `${cookie}; ${cookiePair(created)}` },
    });

    expect(SHOWN_KEY.test(await page.text())).toBe(false);
  });

  it('shows when each key was created and when it was last used', async () => {
    const cookie = await logIn();
    const key = await createKey(cookie);
    const { createdAt } = (await auth.listApiKeys())[0]!;

    await expect(keysPage(cookie)).resolves.toMatch(/Never/u);
    await testApp.request('/mcp', listArtifactsCall({ Authorization: `Bearer ${key}` }));

    const page = await keysPage(cookie);
    const { lastUsedAt } = (await auth.listApiKeys())[0]!;
    expect(lastUsedAt).not.toBeNull();
    expect(page).toContain(`datetime="${createdAt}"`);
    expect(page).toContain(`datetime="${lastUsedAt!}"`);
    expect(page).not.toMatch(/Never/u);
  });

  it('records no use for a refused /mcp request', async () => {
    await createKey(await logIn());

    await testApp.request('/mcp', listArtifactsCall({ Authorization: 'Bearer art_wrong' }));

    expect((await auth.listApiKeys()).map(({ lastUsedAt }) => lastUsedAt)).toEqual([null]);
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

  it('revokes every key at once', async () => {
    const cookie = await logIn();
    const first = await createKey(cookie, 'laptop agent');
    const second = await createKey(cookie, 'build server');
    await expect(keysPage(cookie)).resolves.toContain('action="/keys/revoke-all"');

    const res = await testApp.request('/keys/revoke-all', formPost({}, { Cookie: cookie }));

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/keys');
    const calls = await Promise.all(
      [first, second].map(async (key) =>
        testApp.request('/mcp', listArtifactsCall({ Authorization: `Bearer ${key}` })),
      ),
    );
    expect(calls.map(({ status }) => status)).toEqual([401, 401]);
    const after = await keysPage(cookie);
    expect(after).not.toContain('laptop agent');
    expect(after).not.toContain('build server');
  });

  it('refuses to revoke every key from another origin or without a session', async () => {
    const cookie = await logIn();
    const key = await createKey(cookie);

    const foreign = await testApp.request(
      '/keys/revoke-all',
      formPost({}, { Cookie: cookie, Origin: 'https://evil.example' }),
    );
    const anonymous = await testApp.request('/keys/revoke-all', formPost({}, {}));

    expect(foreign.status).toBe(403);
    expect(anonymous.status).toBe(401);
    const call = await testApp.request(
      '/mcp',
      listArtifactsCall({ Authorization: `Bearer ${key}` }),
    );
    expect(call.status).toBe(200);
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
      headers: { Cookie: cookiePair(res) },
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

  // A same-site page on another port gets the Lax session cookie, so it could
  // frame these pages and steer the owner's clicks on their forms.
  it('refuses to let the login, key, or gallery pages be framed', async () => {
    const cookie = await logIn();

    const responses = await Promise.all([
      testApp.request('/login'),
      testApp.request('/keys', { headers: { Cookie: cookie } }),
      testApp.request('/', { headers: { Cookie: cookie } }),
      testApp.request('/p/auth', { headers: { Cookie: cookie } }),
    ]);

    for (const res of responses) {
      expect(res.status).toBe(200);
      expect(res.headers.get('x-frame-options')).toBe('DENY');
      expect(res.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
    }
  });

  // Sandboxed HTML artifacts embed other artifacts, from an opaque origin.
  it('lets artifacts be framed', async () => {
    const artifact = await createText('embedded notes');
    const cookie = await logIn();

    const res = await testApp.request(`/a/${artifact.id}`, { headers: { Cookie: cookie } });

    expect(res.status).toBe(200);
    expect(res.headers.get('x-frame-options')).toBeNull();
    expect(res.headers.get('content-security-policy')).toBeNull();
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

  it('reads one artifact through a signed URL without a session', async () => {
    const artifact = await createText('rendered for a preview');

    const res = await testApp.request(await auth.artifactUrls.signedPath(artifact.id));

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toMatch(/^private\b/u);
    await expect(res.text()).resolves.toContain('rendered for a preview');
  });

  it('refuses an expired signed URL', async () => {
    let now = new Date();
    const timedAuth = createOwnerAuth({
      now: () => now,
      password: PASSWORD,
      store: await SqliteOwnerAuthStore.open(join(dataDir, 'artifacts.db')),
    });
    const timedApp = createApp({ artifacts: service, auth: timedAuth, mcp: service });
    const artifact = await createText('expired preview');
    const path = await timedAuth.artifactUrls.signedPath(artifact.id);

    now = new Date(now.getTime() + SIGNED_URL_LIFETIME_SECONDS * 1000);
    const res = await timedApp.request(path);

    expect(res.status).toBe(403);
    await expect(res.text()).resolves.not.toContain('expired preview');
  });

  it('refuses a tampered signed URL, and one used for anything but its artifact', async () => {
    const artifact = await createText('owner eyes only');
    const other = await createText('another secret');
    const signed = new URL(await auth.artifactUrls.signedPath(artifact.id), ORIGIN);
    const query = signed.searchParams;
    const later = new URLSearchParams({
      expires: String(Number(query.get('expires')) + 3600),
      signature: query.get('signature')!,
    });

    const paths = [
      `/a/${artifact.id}?${later.toString()}`,
      `/a/${artifact.id}?expires=${query.get('expires')!}&signature=${'A'.repeat(43)}`,
      `/a/${other.id}${signed.search}`,
      `/a/${artifact.id}/thumb${signed.search}`,
      `/${signed.search}`,
    ];
    const responses = await Promise.all(paths.map(async (path) => testApp.request(path)));

    expect(responses.map((res) => res.status)).toEqual([403, 403, 403, 403, 403]);
    const bodies = await Promise.all(responses.map((res) => res.text()));
    expect(bodies.join('')).not.toMatch(/owner eyes only|another secret/u);
  });

  it('lets a signed-in owner through even with a stale signature', async () => {
    const artifact = await createText('still mine');
    const cookie = await logIn();

    const res = await testApp.request(`/a/${artifact.id}?expires=1&signature=stale`, {
      headers: { Cookie: cookie },
    });

    expect(res.status).toBe(200);
  });

  it('signs an HTML artifact’s embedded URLs so they load without a session', async () => {
    const image = await createImage();
    const html = await createHtml(
      `<img src="${buildArtifactUrl(image.id)}" alt="absolute"><img src="/a/${image.id}#x">`,
    );
    const cookie = await logIn();

    const res = await testApp.request(`/a/${html.id}`, { headers: { Cookie: cookie } });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toBe(
      'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-modals',
    );
    const [absolute, relative] = sources(await res.text());
    expect(absolute).toMatch(new RegExp(`^${buildArtifactUrl(image.id)}${SIGNED_EMBED}$`, 'u'));
    expect(relative).toMatch(new RegExp(`^/a/${image.id}${SIGNED_EMBED}#x$`, 'u'));
    const loaded = await Promise.all(
      [absolute!, relative!].map(async (url) => testApp.request(pathOf(url))),
    );
    expect(loaded.map((embed) => embed.status)).toEqual([200, 200]);
    const bodies = await Promise.all(loaded.map(async (embed) => embed.arrayBuffer()));
    expect(bodies.map((body) => new Uint8Array(body))).toEqual([PNG, PNG]);
  });

  it('extracts and stores again an embed template whose stored row cannot be read', async () => {
    const image = await createImage();
    const html = await createHtml(`<img src="/a/${image.id}">`);
    const database = new DatabaseSync(join(dataDir, 'artifacts.db'));
    const storedEmbeds = () =>
      database
        .prepare('SELECT embeds FROM artifact_embed_templates WHERE artifact_id = ?')
        .get(html.id)?.embeds;
    const intact = storedEmbeds();
    database
      .prepare('UPDATE artifact_embed_templates SET embeds = ? WHERE artifact_id = ?')
      .run('not json', html.id);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const cookie = await logIn();

    const res = await testApp.request(`/a/${html.id}`, { headers: { Cookie: cookie } });

    expect(res.status).toBe(200);
    expect(sources(await res.text())[0]).toMatch(
      new RegExp(`^/a/${image.id}${SIGNED_EMBED}$`, 'u'),
    );
    expect(intact).toContain(image.id);
    expect(storedEmbeds()).toBe(intact);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('embed template read failed'));
    stderr.mockRestore();
    database.close();
  });

  it('keeps an embed URL working past the renderer’s lifetime, then refuses it', async () => {
    // The start of a five-minute window, so the embed URL lasts 15 minutes.
    let now = new Date('2026-09-29T12:05:00.000Z');
    const timedAuth = createOwnerAuth({
      now: () => now,
      password: PASSWORD,
      store: await SqliteOwnerAuthStore.open(join(dataDir, 'artifacts.db')),
    });
    const timedApp = createApp({ artifacts: service, auth: timedAuth, mcp: service });
    const image = await createImage();
    const html = await createHtml(`<img src="/a/${image.id}">`);
    const page = await timedApp.request(await timedAuth.artifactUrls.signedPath(html.id));
    const [embedUrl] = sources(await page.text());
    const viewedAt = now.getTime();

    now = new Date(viewedAt + SIGNED_URL_LIFETIME_SECONDS * 1000);
    expect((await timedApp.request(embedUrl!)).status).toBe(200);

    now = new Date(viewedAt + 15 * 60_000 - 1000);
    expect((await timedApp.request(embedUrl!)).status).toBe(200);

    now = new Date(viewedAt + 15 * 60_000);
    expect((await timedApp.request(embedUrl!)).status).toBe(403);
  });

  it('serves the same embed URLs to every view in the same five minutes', async () => {
    let now = new Date('2026-09-29T12:05:00.000Z');
    const timedAuth = createOwnerAuth({
      now: () => now,
      password: PASSWORD,
      store: await SqliteOwnerAuthStore.open(join(dataDir, 'artifacts.db')),
    });
    const timedApp = createApp({ artifacts: service, auth: timedAuth, mcp: service });
    const image = await createImage();
    const html = await createHtml(`<img src="/a/${image.id}">`);
    const view = async (): Promise<string[]> => {
      const page = await timedApp.request(await timedAuth.artifactUrls.signedPath(html.id));
      return sources(await page.text());
    };

    const first = await view();
    now = new Date('2026-09-29T12:09:59.000Z');
    const second = await view();

    expect(second).toEqual(first);
  });

  it('refuses an embed signature used for another artifact or altered', async () => {
    const image = await createImage();
    const secret = await createText('not embedded anywhere');
    const html = await createHtml(`<img src="/a/${image.id}">`);
    const cookie = await logIn();
    const page = await testApp.request(`/a/${html.id}`, { headers: { Cookie: cookie } });
    const embed = new URL(sources(await page.text())[0]!, ORIGIN);
    const signature = embed.searchParams.get('signature')!;
    const altered = new URLSearchParams({
      expires: embed.searchParams.get('expires')!,
      signature: `${signature.slice(0, -1)}${signature.endsWith('A') ? 'B' : 'A'}`,
    });

    const responses = await Promise.all(
      [`/a/${secret.id}${embed.search}`, `/a/${image.id}?${altered.toString()}`].map(async (path) =>
        testApp.request(path),
      ),
    );

    expect(responses.map((res) => res.status)).toEqual([403, 403]);
    await expect(responses[0]!.text()).resolves.not.toContain('not embedded anywhere');
  });

  it('signs the embeds of an HTML artifact that is itself read through a signed URL', async () => {
    const image = await createImage();
    const inner = await createHtml(`<img src="/a/${image.id}">`);
    const outer = await createHtml(`<iframe src="/a/${inner.id}"></iframe>`);
    const cookie = await logIn();

    const page = await testApp.request(`/a/${outer.id}`, { headers: { Cookie: cookie } });
    const [frameUrl] = sources(await page.text());
    const frame = await testApp.request(frameUrl!);
    const [imageUrl] = sources(await frame.text());
    const loaded = await testApp.request(imageUrl!);

    expect([frame.status, loaded.status]).toEqual([200, 200]);
    expect(new Uint8Array(await loaded.arrayBuffer())).toEqual(PNG);
  });

  it('lets the thumbnail queue render an artifact through a signed URL', async () => {
    const artifact = await createText('preview me');
    const store = new Map<string, Uint8Array>();
    const queue = createThumbnailQueue({
      artifactPath: auth.artifactUrls.signedPath,
      lookup: service.findArtifact,
      store: {
        has: async (id) => store.has(id),
        read: async (id) => store.get(id) ?? null,
        remove: async (id) => {
          store.delete(id);
        },
        write: async (id, bytes) => {
          store.set(id, bytes);
        },
      },
    });
    // Stands in for the headless browser: it fetches the target with no
    // cookie and keeps the page body as the "screenshot".
    const renderer = {
      close: () => Promise.resolve(),
      render: async ({ url }: { url: string }) => {
        const res = await testApp.request(url);
        return res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
      },
    };

    queue.start(renderer, ORIGIN);
    queue.enqueue(artifact.id);
    await queue.idle();

    expect(new TextDecoder().decode(store.get(artifact.id))).toContain('preview me');
  });
});

// The bindings @hono/node-server passes a request, reduced to its peer address.
function socket(remoteAddress: string) {
  return { incoming: { socket: { remoteAddress } } };
}

describe('login limits per client address', () => {
  // Fills one client's login limit with wrong passwords.
  async function exhaust(app: ReturnType<typeof createApp>, headers: Record<string, string>) {
    await Promise.all(
      Array.from({ length: LOGIN_ATTEMPT_LIMIT }, async () =>
        app.request('/login', loginRequest('wrong', { headers: { Origin: ORIGIN, ...headers } })),
      ),
    );
  }

  async function appWithHeader(clientAddressHeader?: string) {
    const auth = createOwnerAuth({
      ...(clientAddressHeader === undefined ? {} : { clientAddressHeader }),
      password: PASSWORD,
      store: await SqliteOwnerAuthStore.open(join(dataDir, 'artifacts.db')),
    });
    return createApp({ artifacts: service, auth, mcp: service });
  }

  it('reads the client address from the configured header', async () => {
    const app = await appWithHeader('CF-Connecting-IP');
    await exhaust(app, { 'CF-Connecting-IP': '203.0.113.7' });

    const other = await app.request(
      '/login',
      loginRequest(PASSWORD, { headers: { 'CF-Connecting-IP': '198.51.100.20', Origin: ORIGIN } }),
    );
    const same = await app.request(
      '/login',
      loginRequest(PASSWORD, { headers: { 'CF-Connecting-IP': '203.0.113.7', Origin: ORIGIN } }),
    );

    expect(other.status).toBe(303);
    expect(same.status).toBe(429);
  });

  it('ignores a client address header that is not configured', async () => {
    const app = await appWithHeader();
    await exhaust(app, { 'CF-Connecting-IP': '203.0.113.7', 'X-Forwarded-For': '203.0.113.7' });

    const res = await app.request(
      '/login',
      loginRequest(PASSWORD, {
        headers: {
          'CF-Connecting-IP': '198.51.100.20',
          Origin: ORIGIN,
          'X-Forwarded-For': '1.2.3.4',
        },
      }),
    );

    expect(res.status).toBe(429);
  });

  it('ignores other headers when one is configured', async () => {
    const app = await appWithHeader('CF-Connecting-IP');
    await exhaust(app, { 'X-Forwarded-For': '203.0.113.7' });

    const res = await app.request(
      '/login',
      loginRequest(PASSWORD, { headers: { Origin: ORIGIN, 'X-Forwarded-For': '198.51.100.20' } }),
    );

    expect(res.status).toBe(429);
  });

  it('counts a list-valued header by its last entry, which the nearest proxy added', async () => {
    const app = await appWithHeader('X-Forwarded-For');
    await Promise.all(
      Array.from({ length: LOGIN_ATTEMPT_LIMIT }, async (_, index) =>
        app.request(
          '/login',
          loginRequest('wrong', {
            headers: { Origin: ORIGIN, 'X-Forwarded-For': `10.0.0.${String(index)}, 203.0.113.7` },
          }),
        ),
      ),
    );

    const res = await app.request(
      '/login',
      loginRequest(PASSWORD, { headers: { Origin: ORIGIN, 'X-Forwarded-For': '203.0.113.7' } }),
    );

    expect(res.status).toBe(429);
  });

  it('falls back to the socket address when no header is configured', async () => {
    const app = await appWithHeader();
    await Promise.all(
      Array.from({ length: LOGIN_ATTEMPT_LIMIT }, async () =>
        app.request('/login', loginRequest('wrong'), socket('203.0.113.7')),
      ),
    );

    const other = await app.request('/login', loginRequest(PASSWORD), socket('198.51.100.20'));
    const same = await app.request('/login', loginRequest(PASSWORD), socket('203.0.113.7'));

    expect(other.status).toBe(303);
    expect(same.status).toBe(429);
  });

  it('counts an attempt over a real Node connection against its peer address', async () => {
    const server = serve({ fetch: (await appWithHeader()).fetch, hostname: '127.0.0.1', port: 0 });
    try {
      await once(server, 'listening');
      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('expected serve() to bind a network address');
      }
      const origin = `http://127.0.0.1:${String(address.port)}`;

      const res = await fetch(
        `${origin}/login`,
        loginRequest('wrong', { headers: { Origin: origin } }),
      );

      expect(res.status).toBe(401);
      const database = new DatabaseSync(join(dataDir, 'artifacts.db'));
      expect(database.prepare('SELECT client_address FROM login_attempts').all()).toEqual([
        { client_address: '127.0.0.1' },
      ]);
      database.close();
    } finally {
      await promisify(server.close.bind(server))();
    }
  });
});
