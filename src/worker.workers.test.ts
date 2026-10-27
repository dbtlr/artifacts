import {
  applyD1Migrations,
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { z } from 'zod';

import { LOGIN_ATTEMPT_LIMIT } from './auth/owner-auth.js';
import { D1SecretStore } from './data/d1-secret-store.js';
import { emptyBucket } from './data/r2-bucket.test-support.js';
import { createSecretService } from './secrets/service.js';
import type { WorkerEnv } from './worker-services.js';
import { createWorkerServices } from './worker-services.js';
import worker from './worker.js';

// The Worker entry as Cloudflare calls it: the default export's fetch and
// scheduled handlers, with the test bindings from vite.config.ts plus a stub
// Static Assets fetcher. The public base URL here matches the binding, which
// workerd also copies into process.env, where the shared app reads it.
const BASE_URL = env.MUNINN_PUBLIC_BASE_URL;
const PASSWORD = env.MUNINN_OWNER_PASSWORD;
const SESSION_COOKIE = 'artifacts_session';

const TABLES = [
  'api_keys',
  'artifact_embed_templates',
  'artifact_renderings',
  'artifacts',
  'login_attempts',
  'owner_sessions',
  'secret_claims',
  'secret_upload_slots',
  'secrets',
];

beforeEach(async () => {
  await applyD1Migrations(env.MUNINN_DB, env.TEST_MIGRATIONS);
  await Promise.all(TABLES.map((table) => env.MUNINN_DB.prepare(`DELETE FROM ${table}`).run()));
  await emptyBucket(env.MUNINN_BUCKET);
});

// Files the stub serves, by the path Static Assets would look up.
const ASSET_FILES: Record<string, string> = {
  '/app.css': 'body{}',
  '/apple-touch-icon.png': 'touch icon bytes',
  '/favicon-32.png': 'png icon bytes',
  '/favicon.svg': '<svg/>',
};

function stubAssets() {
  const requested: string[] = [];
  return {
    fetch: (request: Request) => {
      const { pathname } = new URL(request.url);
      requested.push(pathname);
      const body = ASSET_FILES[pathname];
      return Promise.resolve(
        body === undefined ? new Response('stub miss', { status: 404 }) : new Response(body),
      );
    },
    requested,
  };
}

function workerEnv(overrides: Partial<Record<string, unknown>> = {}): WorkerEnv {
  return { ...env, ASSETS: stubAssets(), ...overrides };
}

async function call(path: string, init: RequestInit = {}, testEnv = workerEnv()) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${BASE_URL}${path}`, init), testEnv, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

function loginRequest(password: string, headers: Record<string, string> = {}): RequestInit {
  return {
    body: new URLSearchParams({ password }).toString(),
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: BASE_URL,
      ...headers,
    },
    method: 'POST',
  };
}

async function logIn(testEnv = workerEnv()): Promise<string> {
  const res = await call('/login', loginRequest(PASSWORD), testEnv);
  expect(res.status).toBe(303);
  const token = new RegExp(`${SESSION_COOKIE}=([^;]+)`, 'u').exec(
    res.headers.get('set-cookie') ?? '',
  )?.[1];
  expect(token).toBeDefined();
  return `${SESSION_COOKIE}=${token ?? ''}`;
}

function mcpCall(method: string, params: object, headers: Record<string, string> = {}) {
  return {
    body: JSON.stringify({ id: 1, jsonrpc: '2.0', method, params }),
    headers: {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      ...headers,
    },
    method: 'POST',
  };
}

const toolResponseSchema = z.object({
  result: z.object({
    content: z.array(z.object({ text: z.string() })),
    isError: z.boolean().optional(),
  }),
});
const addedArtifactSchema = z.object({ id: z.string() });

describe('worker configuration', () => {
  it.each([
    ['a missing owner password', { MUNINN_OWNER_PASSWORD: undefined }, 'MUNINN_OWNER_PASSWORD'],
    ['a blank owner password', { MUNINN_OWNER_PASSWORD: '   ' }, 'MUNINN_OWNER_PASSWORD'],
    [
      'a short owner password',
      { MUNINN_OWNER_PASSWORD: 'fifteen-chars!!' },
      'MUNINN_OWNER_PASSWORD',
    ],
    ['a missing public base URL', { MUNINN_PUBLIC_BASE_URL: undefined }, 'MUNINN_PUBLIC_BASE_URL'],
    [
      'an invalid public base URL',
      { MUNINN_PUBLIC_BASE_URL: 'muninn.example' },
      'MUNINN_PUBLIC_BASE_URL',
    ],
    ['a legacy variable', { ARTIFACTS_OWNER_PASSWORD: PASSWORD }, 'ARTIFACTS_OWNER_PASSWORD'],
  ])('answers every request with a plain-text 500 for %s', async (_case, overrides, setting) => {
    const testEnv = workerEnv(overrides);

    const responses = await Promise.all(
      ['/', '/login', '/assets/app.css', '/mcp'].map(async (path) => call(path, {}, testEnv)),
    );

    for (const res of responses) {
      expect(res.status).toBe(500);
      expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    }
    const bodies = await Promise.all(responses.map(async (res) => res.text()));
    for (const body of bodies) {
      expect(body).toContain(setting);
      expect(body).not.toContain('<');
    }
  });

  it('refuses to run the scheduled sweep when misconfigured', async () => {
    const ctx = createExecutionContext();

    await expect(
      worker.scheduled(
        createScheduledController(),
        workerEnv({ MUNINN_OWNER_PASSWORD: undefined }),
        ctx,
      ),
    ).rejects.toThrow(/MUNINN_OWNER_PASSWORD/u);
  });
});

describe('worker owner auth', () => {
  it('sends a request without a session to the login form', async () => {
    const res = await call('/');

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toMatch(/^\/login/u);
  });

  it('logs in with the password and then serves the gallery', async () => {
    const cookie = await logIn();

    const res = await call('/', { headers: { Cookie: cookie } });

    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toContain('Muninn');
  });

  it('counts login attempts per CF-Connecting-IP address', async () => {
    const testEnv = workerEnv();
    const wrong = await Promise.all(
      Array.from({ length: LOGIN_ATTEMPT_LIMIT }, async () =>
        call(
          '/login',
          loginRequest('the wrong password', { 'CF-Connecting-IP': '203.0.113.1' }),
          testEnv,
        ),
      ),
    );
    expect(wrong.map((res) => res.status)).toEqual(Array(LOGIN_ATTEMPT_LIMIT).fill(401));

    const limited = await call(
      '/login',
      loginRequest(PASSWORD, { 'CF-Connecting-IP': '203.0.113.1' }),
      testEnv,
    );
    const other = await call(
      '/login',
      loginRequest(PASSWORD, { 'CF-Connecting-IP': '203.0.113.2' }),
      testEnv,
    );

    expect(limited.status).toBe(429);
    expect(other.status).toBe(303);
  });
});

describe('worker MCP', () => {
  it('refuses a request without an API key', async () => {
    const res = await call(
      '/mcp',
      mcpCall('tools/call', { arguments: {}, name: 'list_artifacts' }),
    );

    expect(res.status).toBe(401);
  });

  it('creates a Markdown artifact with an API key and serves its rendering', async () => {
    const testEnv = workerEnv();
    const { key } = await createWorkerServices(testEnv).auth.createApiKey('workers test');
    const bearer = { Authorization: `Bearer ${key}` };

    const initialized = await call(
      '/mcp',
      mcpCall(
        'initialize',
        {
          capabilities: {},
          clientInfo: { name: 'workers-test', version: '0' },
          protocolVersion: '2025-03-26',
        },
        bearer,
      ),
      testEnv,
    );
    expect(initialized.status).toBe(200);

    const added = await call(
      '/mcp',
      mcpCall(
        'tools/call',
        {
          arguments: {
            content: '# Hello from D1\n\nStored in **R2**.',
            description: 'Worker entry test',
            mediaType: 'text/markdown',
            project: 'workers',
            title: 'Worker Markdown',
          },
          name: 'add_artifact',
        },
        bearer,
      ),
      testEnv,
    );
    expect(added.status).toBe(200);
    const { result } = toolResponseSchema.parse(await added.json());
    expect(result.isError).toBeUndefined();
    const { id } = addedArtifactSchema.parse(JSON.parse(result.content[0]?.text ?? '{}'));

    const cookie = await logIn(testEnv);
    const page = await call(`/a/${id}`, { headers: { Cookie: cookie } }, testEnv);

    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('Hello from D1</h1>');
    expect(html).toContain('<strong>R2</strong>');
  });
});

describe('worker static files', () => {
  it('serves /assets/* from Static Assets without the prefix, before auth', async () => {
    const assets = stubAssets();

    const res = await call('/assets/app.css', {}, workerEnv({ ASSETS: assets }));

    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toBe('body{}');
    expect(assets.requested).toEqual(['/app.css']);
  });

  it.each([
    ['/favicon.ico', '/favicon-32.png', 'png icon bytes'],
    ['/favicon.svg', '/favicon.svg', '<svg/>'],
    ['/apple-touch-icon.png', '/apple-touch-icon.png', 'touch icon bytes'],
  ])('serves %s from the %s asset', async (path, file, body) => {
    const assets = stubAssets();

    const res = await call(path, {}, workerEnv({ ASSETS: assets }));

    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toBe(body);
    expect(assets.requested).toEqual([file]);
  });

  it('falls through to the app when Static Assets has no such file', async () => {
    const assets = stubAssets();

    const res = await call('/assets/missing.js', {}, workerEnv({ ASSETS: assets }));

    expect(assets.requested).toEqual(['/missing.js']);
    expect(res.status).toBe(404);
    await expect(res.text()).resolves.not.toBe('stub miss');
  });
});

describe('worker scheduled handler', () => {
  it('removes an expired secret', async () => {
    const longAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    await createSecretService({
      now: () => longAgo,
      store: new D1SecretStore(env.MUNINN_DB),
    }).create({ content: new TextEncoder().encode('stale'), label: 'Old', ttlSeconds: 3600 });
    const ctx = createExecutionContext();

    await worker.scheduled(createScheduledController(), workerEnv(), ctx);
    await waitOnExecutionContext(ctx);

    const { results } = await env.MUNINN_DB.prepare('SELECT id FROM secrets').all();
    expect(results).toEqual([]);
  });
});
