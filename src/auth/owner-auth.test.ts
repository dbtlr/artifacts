import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';

import { SqliteOwnerAuthStore } from '../data/sqlite-owner-auth-store.js';
import {
  createOwnerAuth,
  LOGIN_ATTEMPT_LIMIT,
  LOGIN_ATTEMPT_WINDOW_SECONDS,
  resolveOwnerPassword,
  SESSION_LIFETIME_SECONDS,
} from './owner-auth.js';
import type { OwnerAuth } from './owner-auth.js';

const PASSWORD = 'correct horse battery staple';

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
    expect(resolveOwnerPassword({ ARTIFACTS_OWNER_PASSWORD: ' secret ' })).toBe(' secret ');
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
  async function failLogins(count: number): Promise<void> {
    if (count === 0) {
      return;
    }
    await expect(auth.logIn('wrong')).resolves.toMatchObject({ reason: 'incorrect-password' });
    await failLogins(count - 1);
  }

  async function logInToken(): Promise<string> {
    const result = await auth.logIn(PASSWORD);
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
    await expect(auth.logIn('wrong')).resolves.toEqual({
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

  it('refuses every attempt, even the right password, once the attempt limit is reached', async () => {
    await failLogins(LOGIN_ATTEMPT_LIMIT);

    await expect(auth.logIn(PASSWORD)).resolves.toEqual({
      ok: false,
      reason: 'rate-limited',
      retryAfterSeconds: LOGIN_ATTEMPT_WINDOW_SECONDS,
    });
  });

  it('counts parallel attempts, so a burst cannot outrun the limit', async () => {
    const results = await Promise.all(
      Array.from({ length: LOGIN_ATTEMPT_LIMIT + 5 }, () => auth.logIn('wrong')),
    );

    expect(results.filter((result) => !result.ok && result.reason === 'rate-limited')).toHaveLength(
      5,
    );
  });

  it('allows attempts again once the oldest counted attempt leaves the window', async () => {
    await auth.logIn('wrong');
    advance(60);
    await failLogins(LOGIN_ATTEMPT_LIMIT - 1);

    await expect(auth.logIn(PASSWORD)).resolves.toMatchObject({
      retryAfterSeconds: LOGIN_ATTEMPT_WINDOW_SECONDS - 60,
    });
    advance(LOGIN_ATTEMPT_WINDOW_SECONDS - 60);
    await expect(auth.logIn(PASSWORD)).resolves.toMatchObject({ ok: true });
  });

  it('clears counted attempts after a successful login', async () => {
    await failLogins(LOGIN_ATTEMPT_LIMIT - 1);
    await logInToken();

    await expect(auth.logIn('wrong')).resolves.toMatchObject({ reason: 'incorrect-password' });
  });
});
