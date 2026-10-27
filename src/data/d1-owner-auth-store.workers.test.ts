import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vite-plus/test';

import type { D1DatabaseBinding, D1PreparedStatementBinding } from './d1-database.js';
import { D1OwnerAuthStore } from './d1-owner-auth-store.js';
import { ownerAuthStoreContract } from './owner-auth-store-contract.test-support.js';

// Applies the shared migrations as `wrangler d1 migrations apply` would, then
// empties the tables, so each test starts clean whatever storage isolation
// the test runtime provides.
beforeEach(async () => {
  await applyD1Migrations(env.MUNINN_DB, env.TEST_MIGRATIONS);
  await Promise.all(
    ['login_attempts', 'owner_sessions', 'api_keys', 'url_signing_keys'].map((table) =>
      env.MUNINN_DB.prepare(`DELETE FROM ${table}`).run(),
    ),
  );
});

ownerAuthStoreContract('d1', async () => ({
  loginAttemptRows: async () =>
    (await env.MUNINN_DB.prepare('SELECT * FROM login_attempts').all()).results,
  store: new D1OwnerAuthStore(env.MUNINN_DB),
}));

// A statement whose run waits for `hold` to settle first.
function heldStatement(
  statement: D1PreparedStatementBinding,
  hold: () => Promise<void>,
): D1PreparedStatementBinding {
  return {
    all: async () => statement.all(),
    bind: (...values) => heldStatement(statement.bind(...values), hold),
    first: async () => statement.first(),
    run: async () => {
      await hold();
      return statement.run();
    },
  };
}

// The D1 database, except that every insert into url_signing_keys waits for
// `hold` before it runs.
function holdingSigningKeyInserts(hold: () => Promise<void>): D1DatabaseBinding {
  return {
    prepare: (query) => {
      const statement = env.MUNINN_DB.prepare(query);
      return query.startsWith('INSERT') && query.includes('url_signing_keys')
        ? heldStatement(statement, hold)
        : statement;
    },
  };
}

// node:sqlite runs each call synchronously, so only D1 can interleave two
// creators between their steps.
describe('d1 URL signing key creation', () => {
  it('keeps the first stored key when a held creator inserts after another', async () => {
    const reached = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const held = new D1OwnerAuthStore(
      holdingSigningKeyInserts(async () => {
        reached.resolve();
        await release.promise;
      }),
    );
    const prompt = new D1OwnerAuthStore(env.MUNINN_DB);

    const heldKey = held.createUrlSigningKey(10, 'held');
    await reached.promise;
    const promptKey = await prompt.createUrlSigningKey(10, 'prompt');
    release.resolve();

    expect(promptKey).toBe('prompt');
    await expect(heldKey).resolves.toBe('prompt');
    const { results } = await env.MUNINN_DB.prepare('SELECT * FROM url_signing_keys').all();
    expect(results).toEqual([{ bucket: 10, signing_key: 'prompt' }]);
  });
});
