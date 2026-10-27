import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach } from 'vite-plus/test';

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
