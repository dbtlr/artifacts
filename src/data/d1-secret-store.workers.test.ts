import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vite-plus/test';

import { createSecretService } from '../secrets/service.js';
import { D1SecretStore } from './d1-secret-store.js';
import { secretStoreContract } from './secret-store-contract.test-support.js';

// Applies the shared migrations as `wrangler d1 migrations apply` would, then
// empties the tables, so each test starts clean whatever storage isolation
// the test runtime provides.
beforeEach(async () => {
  await applyD1Migrations(env.MUNINN_DB, env.TEST_MIGRATIONS);
  await Promise.all(
    ['secrets', 'secret_upload_slots', 'secret_claims'].map((table) =>
      env.MUNINN_DB.prepare(`DELETE FROM ${table}`).run(),
    ),
  );
});

secretStoreContract('d1', async () => ({
  rows: async (table) => (await env.MUNINN_DB.prepare(`SELECT * FROM ${table}`).all()).results,
  store: new D1SecretStore(env.MUNINN_DB),
}));

// The service's WebCrypto calls run in workerd as they do on Node.
describe('secret service on D1', () => {
  it('stores a secret and reveals it once', async () => {
    const service = createSecretService({ store: new D1SecretStore(env.MUNINN_DB) });
    const content = new TextEncoder().encode('workers secret');

    const { id, key } = await service.create({ content, label: 'Workers' });
    const { claimToken } = (await service.claim(id, key)) ?? { claimToken: '' };

    await expect(service.download(claimToken)).resolves.toEqual({
      content,
      filename: null,
      label: 'Workers',
    });
    await expect(service.reveal(id, key)).resolves.toBeNull();
    await expect(service.status(id)).resolves.toBe('read');
  });
});
