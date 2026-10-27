import { describe, expect, it } from 'vite-plus/test';

import type { OwnerAuthStore, StoredApiKey } from '../auth/types.js';

// A store under test and a raw view of its login attempts, for the pruning
// that the store's own methods cannot show.
export type OwnerAuthStoreHarness = {
  loginAttemptRows: () => Promise<Record<string, unknown>[]>;
  store: OwnerAuthStore;
};

// Minutes after a fixed start, as the ISO text the store compares.
function at(minutes: number): string {
  return new Date(Date.UTC(2026, 0, 1) + minutes * 60_000).toISOString();
}

function attemptFrom(
  clientAddress: string,
  minutes: number,
): { at: string; clientAddress: string } {
  return { at: at(minutes), clientAddress };
}

function apiKeyNamed(id: string, createdAt = at(0)): StoredApiKey {
  return { createdAt, id, keyHash: `hash-of-${id}`, name: `Key ${id}` };
}

// The start of a window that holds every attempt a test makes.
const windowStart = at(-15);
const roomy = { perClient: 99, total: 99 };

export function ownerAuthStoreContract(
  name: string,
  createHarness: () => Promise<OwnerAuthStoreHarness>,
): void {
  describe(`${name} owner auth store contract`, () => {
    it('records attempts from one address up to the per-client limit', async () => {
      const { store } = await createHarness();
      const limits = { perClient: 2, total: 99 };

      await expect(
        store.reserveLoginAttempt(attemptFrom('a', 0), windowStart, limits),
      ).resolves.toBe(true);
      await expect(
        store.reserveLoginAttempt(attemptFrom('a', 1), windowStart, limits),
      ).resolves.toBe(true);
      await expect(
        store.reserveLoginAttempt(attemptFrom('a', 2), windowStart, limits),
      ).resolves.toBe(false);
      await expect(
        store.reserveLoginAttempt(attemptFrom('b', 2), windowStart, limits),
      ).resolves.toBe(true);

      await expect(store.countLoginAttemptsAfter(windowStart, 'a')).resolves.toEqual({
        client: { count: 2, oldest: at(0) },
        total: { count: 3, oldest: at(0) },
      });
    });

    it('records attempts from all addresses up to the total limit', async () => {
      const { store } = await createHarness();
      const limits = { perClient: 99, total: 2 };

      await expect(
        store.reserveLoginAttempt(attemptFrom('a', 0), windowStart, limits),
      ).resolves.toBe(true);
      await expect(
        store.reserveLoginAttempt(attemptFrom('b', 1), windowStart, limits),
      ).resolves.toBe(true);
      await expect(
        store.reserveLoginAttempt(attemptFrom('c', 2), windowStart, limits),
      ).resolves.toBe(false);

      await expect(store.countLoginAttemptsAfter(windowStart, 'c')).resolves.toEqual({
        client: { count: 0, oldest: null },
        total: { count: 2, oldest: at(0) },
      });
    });

    it('counts toward the limits only attempts after since', async () => {
      const { store } = await createHarness();
      const limits = { perClient: 2, total: 99 };
      await store.reserveLoginAttempt(attemptFrom('a', 0), windowStart, limits);
      await store.reserveLoginAttempt(attemptFrom('a', 5), windowStart, limits);

      await expect(store.reserveLoginAttempt(attemptFrom('a', 10), at(-5), limits)).resolves.toBe(
        false,
      );
      // The attempt at exactly `since` has left the window.
      await expect(store.reserveLoginAttempt(attemptFrom('a', 15), at(0), limits)).resolves.toBe(
        true,
      );
    });

    it('records at most the per-client limit from parallel attempts', async () => {
      const { store } = await createHarness();
      const limits = { perClient: 3, total: 99 };

      const results = await Promise.all(
        Array.from({ length: 10 }, async () =>
          store.reserveLoginAttempt(attemptFrom('a', 0), windowStart, limits),
        ),
      );

      expect(results.filter((recorded) => recorded)).toHaveLength(3);
      await expect(store.countLoginAttemptsAfter(windowStart, 'a')).resolves.toMatchObject({
        client: { count: 3 },
      });
    });

    it('records at most the total limit from parallel attempts', async () => {
      const { store } = await createHarness();
      const limits = { perClient: 99, total: 4 };

      const results = await Promise.all(
        Array.from({ length: 10 }, async (_, index) =>
          store.reserveLoginAttempt(attemptFrom(`client-${String(index)}`, 0), windowStart, limits),
        ),
      );

      expect(results.filter((recorded) => recorded)).toHaveLength(4);
      await expect(store.countLoginAttemptsAfter(windowStart, '')).resolves.toMatchObject({
        total: { count: 4 },
      });
    });

    it('forgets attempts at or before since when it reserves, recorded or not', async () => {
      const { loginAttemptRows, store } = await createHarness();
      await store.reserveLoginAttempt(attemptFrom('a', 0), windowStart, roomy);
      await store.reserveLoginAttempt(attemptFrom('b', 5), windowStart, roomy);
      await store.reserveLoginAttempt(attemptFrom('c', 6), windowStart, roomy);

      await expect(
        store.reserveLoginAttempt(attemptFrom('d', 10), at(5), { perClient: 0, total: 99 }),
      ).resolves.toBe(false);

      expect((await loginAttemptRows()).map((row) => row.client_address)).toEqual(['c']);
    });

    it('counts the attempts after since from one address and from all', async () => {
      const { store } = await createHarness();
      await store.reserveLoginAttempt(attemptFrom('b', 0), windowStart, roomy);
      await store.reserveLoginAttempt(attemptFrom('a', 3), windowStart, roomy);
      await store.reserveLoginAttempt(attemptFrom('a', 1), windowStart, roomy);
      await store.reserveLoginAttempt(attemptFrom('b', 2), windowStart, roomy);

      await expect(store.countLoginAttemptsAfter(at(0), 'a')).resolves.toEqual({
        client: { count: 2, oldest: at(1) },
        total: { count: 3, oldest: at(1) },
      });
      await expect(store.countLoginAttemptsAfter(at(3), 'a')).resolves.toEqual({
        client: { count: 0, oldest: null },
        total: { count: 0, oldest: null },
      });
    });

    it('gives attempts with no address one shared count', async () => {
      const { store } = await createHarness();
      const limits = { perClient: 2, total: 99 };

      await expect(
        store.reserveLoginAttempt(attemptFrom('', 0), windowStart, limits),
      ).resolves.toBe(true);
      await expect(
        store.reserveLoginAttempt(attemptFrom('', 1), windowStart, limits),
      ).resolves.toBe(true);
      await expect(
        store.reserveLoginAttempt(attemptFrom('', 2), windowStart, limits),
      ).resolves.toBe(false);
      await expect(
        store.reserveLoginAttempt(attemptFrom('a', 2), windowStart, limits),
      ).resolves.toBe(true);

      await expect(store.countLoginAttemptsAfter(windowStart, '')).resolves.toEqual({
        client: { count: 2, oldest: at(0) },
        total: { count: 3, oldest: at(0) },
      });
    });

    it('clears the attempts from one address only', async () => {
      const { store } = await createHarness();
      await store.reserveLoginAttempt(attemptFrom('a', 0), windowStart, roomy);
      await store.reserveLoginAttempt(attemptFrom('a', 1), windowStart, roomy);
      await store.reserveLoginAttempt(attemptFrom('', 2), windowStart, roomy);

      await store.clearLoginAttempts('a');
      await expect(store.clearLoginAttempts('missing')).resolves.toBeUndefined();

      await expect(store.countLoginAttemptsAfter(windowStart, 'a')).resolves.toEqual({
        client: { count: 0, oldest: null },
        total: { count: 1, oldest: at(2) },
      });
    });

    it('finds a session until it is removed', async () => {
      const { store } = await createHarness();
      await store.createSession({ createdAt: at(0), expiresAt: at(60), tokenHash: 'session' });

      await expect(store.findSessionExpiry('session')).resolves.toBe(at(60));
      await expect(store.findSessionExpiry('missing')).resolves.toBeNull();

      await store.removeSession('session');
      await expect(store.removeSession('missing')).resolves.toBeUndefined();

      await expect(store.findSessionExpiry('session')).resolves.toBeNull();
    });

    it('removes the sessions that expired by the time a session is created', async () => {
      const { store } = await createHarness();
      await store.createSession({ createdAt: at(0), expiresAt: at(60), tokenHash: 'expired' });
      await store.createSession({ createdAt: at(0), expiresAt: at(61), tokenHash: 'live' });

      await store.createSession({ createdAt: at(60), expiresAt: at(120), tokenHash: 'new' });

      await expect(store.findSessionExpiry('expired')).resolves.toBeNull();
      await expect(store.findSessionExpiry('live')).resolves.toBe(at(61));
      await expect(store.findSessionExpiry('new')).resolves.toBe(at(120));
    });

    it('lists API keys oldest first, without their hashes', async () => {
      const { store } = await createHarness();
      // Keys made in the same millisecond list in the order they were stored.
      await store.createApiKey(apiKeyNamed('second', at(1)));
      await store.createApiKey(apiKeyNamed('first', at(0)));
      await store.createApiKey(apiKeyNamed('third', at(1)));

      await expect(store.listApiKeys()).resolves.toEqual([
        { createdAt: at(0), id: 'first', lastUsedAt: null, name: 'Key first' },
        { createdAt: at(1), id: 'second', lastUsedAt: null, name: 'Key second' },
        { createdAt: at(1), id: 'third', lastUsedAt: null, name: 'Key third' },
      ]);
    });

    it('finds an API key by its hash and records its use', async () => {
      const { store } = await createHarness();
      const key = apiKeyNamed('key');
      await store.createApiKey(key);

      await expect(store.findApiKeyByHash(key.keyHash)).resolves.toEqual({
        id: 'key',
        lastUsedAt: null,
      });
      await expect(store.findApiKeyByHash('missing')).resolves.toBeNull();

      await store.recordApiKeyUse('key', at(5));
      await expect(store.recordApiKeyUse('missing', at(5))).resolves.toBeUndefined();

      await expect(store.findApiKeyByHash(key.keyHash)).resolves.toEqual({
        id: 'key',
        lastUsedAt: at(5),
      });
      await expect(store.listApiKeys()).resolves.toMatchObject([{ id: 'key', lastUsedAt: at(5) }]);
    });

    it('removes one API key or all of them', async () => {
      const { store } = await createHarness();
      await store.createApiKey(apiKeyNamed('first'));
      await store.createApiKey(apiKeyNamed('second'));
      await store.createApiKey(apiKeyNamed('third'));

      await store.removeApiKey('first');
      await expect(store.removeApiKey('missing')).resolves.toBeUndefined();

      expect((await store.listApiKeys()).map(({ id }) => id)).toEqual(['second', 'third']);
      await expect(store.findApiKeyByHash('hash-of-first')).resolves.toBeNull();

      await store.removeAllApiKeys();

      await expect(store.listApiKeys()).resolves.toEqual([]);
      await expect(store.findApiKeyByHash('hash-of-second')).resolves.toBeNull();
    });

    it('keeps the first URL signing key stored for a bucket', async () => {
      const { store } = await createHarness();

      await expect(store.createUrlSigningKey(10, 'first')).resolves.toBe('first');
      await expect(store.createUrlSigningKey(10, 'second')).resolves.toBe('first');

      await expect(store.findUrlSigningKey(10)).resolves.toBe('first');
      await expect(store.findUrlSigningKey(11)).resolves.toBeNull();
    });

    it('gives every parallel creator of a bucket the same URL signing key', async () => {
      const { store } = await createHarness();

      const keys = await Promise.all(
        ['one', 'two', 'three'].map(async (key) => store.createUrlSigningKey(10, key)),
      );

      expect(new Set(keys).size).toBe(1);
      expect(['one', 'two', 'three']).toContain(keys[0]);
      await expect(store.findUrlSigningKey(10)).resolves.toBe(keys[0]);
    });

    it('removes URL signing keys older than the previous bucket when it makes one', async () => {
      const { store } = await createHarness();
      await store.createUrlSigningKey(7, 'seven');
      await store.createUrlSigningKey(8, 'eight');

      await store.createUrlSigningKey(9, 'nine');

      await expect(store.findUrlSigningKey(7)).resolves.toBeNull();
      await expect(store.findUrlSigningKey(8)).resolves.toBe('eight');

      // A key made for an earlier bucket leaves the newer keys alone.
      await store.createUrlSigningKey(5, 'five');

      await expect(store.findUrlSigningKey(8)).resolves.toBe('eight');
      await expect(store.findUrlSigningKey(9)).resolves.toBe('nine');
      await expect(store.findUrlSigningKey(5)).resolves.toBe('five');
    });
  });
}
