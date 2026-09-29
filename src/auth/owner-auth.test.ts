import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';

import { SqliteOwnerAuthStore } from '../data/sqlite-owner-auth-store.js';
import {
  createOwnerAuth,
  LOGIN_ATTEMPT_LIMIT,
  LOGIN_ATTEMPT_TOTAL_LIMIT,
  LOGIN_ATTEMPT_WINDOW_SECONDS,
  OWNER_PASSWORD_MIN_LENGTH,
  resolveClientAddressHeader,
  resolveOwnerPassword,
  SESSION_LIFETIME_SECONDS,
} from './owner-auth.js';
import type { OwnerAuth } from './owner-auth.js';

const PASSWORD = 'correct horse battery staple';
const CLIENT = '203.0.113.7';
const OTHER_CLIENT = '198.51.100.20';

describe('resolveOwnerPassword', () => {
  it('leaves auth off when the variable is unset', () => {
    expect(resolveOwnerPassword({})).toBeUndefined();
  });

  it('refuses a blank password rather than turning auth off', () => {
    expect(() => resolveOwnerPassword({ ARTIFACTS_OWNER_PASSWORD: '  ' })).toThrow(
      /ARTIFACTS_OWNER_PASSWORD must not be blank/u,
    );
  });

  it('returns the configured password verbatim', () => {
    expect(resolveOwnerPassword({ ARTIFACTS_OWNER_PASSWORD: ' a long secret phrase ' })).toBe(
      ' a long secret phrase ',
    );
  });

  it('refuses a password shorter than the minimum', () => {
    expect(() =>
      resolveOwnerPassword({ ARTIFACTS_OWNER_PASSWORD: 'x'.repeat(OWNER_PASSWORD_MIN_LENGTH - 1) }),
    ).toThrow(/ARTIFACTS_OWNER_PASSWORD must be at least 16 characters/u);
  });

  it('accepts a password of exactly the minimum length', () => {
    const password = 'x'.repeat(OWNER_PASSWORD_MIN_LENGTH);

    expect(resolveOwnerPassword({ ARTIFACTS_OWNER_PASSWORD: password })).toBe(password);
  });

  it('counts characters, not UTF-16 code units', () => {
    // Eight emoji are 16 code units but only 8 characters.
    expect(() => resolveOwnerPassword({ ARTIFACTS_OWNER_PASSWORD: '🔑'.repeat(8) })).toThrow(
      /at least 16 characters/u,
    );
  });
});

describe('resolveClientAddressHeader', () => {
  it('names no header when the variable is unset', () => {
    expect(resolveClientAddressHeader({})).toBeUndefined();
  });

  it('returns the configured header name', () => {
    expect(
      resolveClientAddressHeader({ ARTIFACTS_CLIENT_ADDRESS_HEADER: 'CF-Connecting-IP' }),
    ).toBe('CF-Connecting-IP');
  });

  it('refuses a blank header name', () => {
    expect(() => resolveClientAddressHeader({ ARTIFACTS_CLIENT_ADDRESS_HEADER: ' ' })).toThrow(
      /ARTIFACTS_CLIENT_ADDRESS_HEADER must not be blank/u,
    );
  });

  it('refuses a value that is not a header name', () => {
    expect(() =>
      resolveClientAddressHeader({ ARTIFACTS_CLIENT_ADDRESS_HEADER: 'CF-Connecting-IP: 1.2.3.4' }),
    ).toThrow(/ARTIFACTS_CLIENT_ADDRESS_HEADER must be an HTTP header name/u);
  });
});

describe('owner auth', () => {
  let dataDir: string;
  let databasePath: string;
  let now: Date;
  let auth: OwnerAuth;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'artifacts-owner-auth-'));
    databasePath = join(dataDir, 'artifacts.db');
    now = new Date('2026-09-29T12:00:00.000Z');
    auth = createOwnerAuth({
      now: () => now,
      password: PASSWORD,
      store: await SqliteOwnerAuthStore.open(databasePath),
    });
  });

  afterEach(async () => {
    await rm(dataDir, { force: true, recursive: true });
  });

  function advance(seconds: number): void {
    now = new Date(now.getTime() + seconds * 1000);
  }

  // Sequential on purpose: each attempt lands after the previous one.
  async function failLogins(count: number, client = CLIENT): Promise<void> {
    if (count === 0) {
      return;
    }
    await expect(auth.logIn('wrong', client)).resolves.toMatchObject({
      reason: 'incorrect-password',
    });
    await failLogins(count - 1, client);
  }

  async function logInToken(client = CLIENT): Promise<string> {
    const result = await auth.logIn(PASSWORD, client);
    if (!result.ok) {
      throw new Error(`login failed: ${result.reason}`);
    }
    return result.token;
  }

  it('creates a session for the configured password', async () => {
    const token = await logInToken();

    await expect(auth.hasSession(token)).resolves.toBe(true);
  });

  it('rejects a wrong password without creating a session', async () => {
    await expect(auth.logIn('wrong', CLIENT)).resolves.toEqual({
      ok: false,
      reason: 'incorrect-password',
    });
  });

  it('does not accept a missing or unknown session token', async () => {
    await expect(auth.hasSession(undefined)).resolves.toBe(false);
    await expect(auth.hasSession('not-a-session')).resolves.toBe(false);
  });

  it('stores only a hash of the session token', async () => {
    const token = await logInToken();

    const database = new DatabaseSync(databasePath);
    const rows = database.prepare('SELECT * FROM owner_sessions').all();
    database.close();
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it('expires a session after its lifetime', async () => {
    const token = await logInToken();

    advance(SESSION_LIFETIME_SECONDS - 1);
    await expect(auth.hasSession(token)).resolves.toBe(true);
    advance(1);
    await expect(auth.hasSession(token)).resolves.toBe(false);
  });

  it('ends every session when the password changes', async () => {
    const token = await logInToken();

    const rotated = createOwnerAuth({
      now: () => now,
      password: 'a new password',
      store: await SqliteOwnerAuthStore.open(databasePath),
    });

    await expect(rotated.hasSession(token)).resolves.toBe(false);
  });

  it('ends a session on logout', async () => {
    const token = await logInToken();

    await auth.logOut(token);

    await expect(auth.hasSession(token)).resolves.toBe(false);
  });

  it('refuses every attempt from a client, even the right password, once its limit is reached', async () => {
    await failLogins(LOGIN_ATTEMPT_LIMIT);

    await expect(auth.logIn(PASSWORD, CLIENT)).resolves.toEqual({
      ok: false,
      reason: 'rate-limited',
      retryAfterSeconds: LOGIN_ATTEMPT_WINDOW_SECONDS,
    });
  });

  it('does not lock out another client when one exhausts its limit', async () => {
    await failLogins(LOGIN_ATTEMPT_LIMIT, CLIENT);

    await expect(auth.logIn(PASSWORD, OTHER_CLIENT)).resolves.toMatchObject({ ok: true });
    await expect(auth.logIn(PASSWORD, CLIENT)).resolves.toMatchObject({ reason: 'rate-limited' });
  });

  it('refuses every client once the total limit is reached across clients', async () => {
    const clients = Array.from(
      { length: LOGIN_ATTEMPT_TOTAL_LIMIT / LOGIN_ATTEMPT_LIMIT },
      (_, index) => `192.0.2.${String(index)}`,
    );
    await Promise.all(clients.map(async (client) => failLogins(LOGIN_ATTEMPT_LIMIT, client)));
    advance(60);

    await expect(auth.logIn(PASSWORD, OTHER_CLIENT)).resolves.toEqual({
      ok: false,
      reason: 'rate-limited',
      retryAfterSeconds: LOGIN_ATTEMPT_WINDOW_SECONDS - 60,
    });
  });

  it('counts parallel attempts, so a burst cannot outrun the limit', async () => {
    const results = await Promise.all(
      Array.from({ length: LOGIN_ATTEMPT_LIMIT + 5 }, () => auth.logIn('wrong', CLIENT)),
    );

    expect(results.filter((result) => !result.ok && result.reason === 'rate-limited')).toHaveLength(
      5,
    );
  });

  it('allows attempts again once the oldest counted attempt leaves the window', async () => {
    await auth.logIn('wrong', CLIENT);
    advance(60);
    await failLogins(LOGIN_ATTEMPT_LIMIT - 1);

    await expect(auth.logIn(PASSWORD, CLIENT)).resolves.toMatchObject({
      retryAfterSeconds: LOGIN_ATTEMPT_WINDOW_SECONDS - 60,
    });
    advance(LOGIN_ATTEMPT_WINDOW_SECONDS - 60);
    await expect(auth.logIn(PASSWORD, CLIENT)).resolves.toMatchObject({ ok: true });
  });

  it('clears counted attempts after a successful login', async () => {
    await failLogins(LOGIN_ATTEMPT_LIMIT - 1);
    await logInToken();

    await expect(auth.logIn('wrong', CLIENT)).resolves.toMatchObject({
      reason: 'incorrect-password',
    });
  });

  it('keeps counting another client’s attempts after a successful login', async () => {
    await failLogins(LOGIN_ATTEMPT_LIMIT - 1, OTHER_CLIENT);
    await logInToken(CLIENT);

    await failLogins(1, OTHER_CLIENT);
    await expect(auth.logIn(PASSWORD, OTHER_CLIENT)).resolves.toMatchObject({
      reason: 'rate-limited',
    });
  });
});

describe('API keys', () => {
  let dataDir: string;
  let databasePath: string;
  let auth: OwnerAuth;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'artifacts-api-keys-'));
    databasePath = join(dataDir, 'artifacts.db');
    auth = createOwnerAuth({
      now: () => new Date('2026-09-29T12:00:00.000Z'),
      password: PASSWORD,
      store: await SqliteOwnerAuthStore.open(databasePath),
    });
  });

  afterEach(async () => {
    await rm(dataDir, { force: true, recursive: true });
  });

  it('creates a key that authenticates', async () => {
    const { key } = await auth.createApiKey('laptop agent');

    expect(key).toMatch(/^art_[\w-]{43}$/u);
    await expect(auth.hasApiKey(key)).resolves.toBe(true);
  });

  it('does not accept a missing, blank, or unknown key', async () => {
    await auth.createApiKey('laptop agent');

    await expect(auth.hasApiKey(undefined)).resolves.toBe(false);
    await expect(auth.hasApiKey('')).resolves.toBe(false);
    await expect(auth.hasApiKey('art_not-a-key')).resolves.toBe(false);
  });

  it('stores only a hash of the key', async () => {
    const { key } = await auth.createApiKey('laptop agent');

    const database = new DatabaseSync(databasePath);
    const rows = database.prepare('SELECT * FROM api_keys').all();
    database.close();
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(key.slice(4));
  });

  it('lists keys by name and creation time, oldest first, without their secrets', async () => {
    const first = await auth.createApiKey('laptop agent');
    const second = await auth.createApiKey('build server');

    await expect(auth.listApiKeys()).resolves.toEqual([
      { createdAt: '2026-09-29T12:00:00.000Z', id: first.id, name: 'laptop agent' },
      { createdAt: '2026-09-29T12:00:00.000Z', id: second.id, name: 'build server' },
    ]);
  });

  it('refuses a revoked key and keeps the others', async () => {
    const revoked = await auth.createApiKey('laptop agent');
    const kept = await auth.createApiKey('build server');

    await auth.revokeApiKey(revoked.id);

    await expect(auth.hasApiKey(revoked.key)).resolves.toBe(false);
    await expect(auth.hasApiKey(kept.key)).resolves.toBe(true);
    expect((await auth.listApiKeys()).map(({ name }) => name)).toEqual(['build server']);
  });

  it('keeps keys working when the password changes', async () => {
    const { key } = await auth.createApiKey('laptop agent');

    const rotated = createOwnerAuth({
      password: 'a new password',
      store: await SqliteOwnerAuthStore.open(databasePath),
    });

    await expect(rotated.hasApiKey(key)).resolves.toBe(true);
  });
});
