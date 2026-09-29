// Types for the bindings that the `workers` test project in vite.config.ts
// gives to `*.workers.test.ts` files. Only the parts those tests use are
// declared, because the full Workers runtime types clash with the DOM lib.
declare module 'cloudflare:workers' {
  import type { D1Migration } from '@cloudflare/vitest-pool-workers';

  import type { D1DatabaseBinding } from './data/d1-database.js';
  import type { ListableR2Bucket } from './data/r2-bucket.test-support.js';

  export const env: {
    ARTIFACTS_BUCKET: ListableR2Bucket;
    ARTIFACTS_DB: D1DatabaseBinding;
    TEST_MIGRATIONS: D1Migration[];
  };
}

declare module 'cloudflare:test' {
  import type { D1Migration } from '@cloudflare/vitest-pool-workers';

  import type { D1DatabaseBinding } from './data/d1-database.js';

  export function applyD1Migrations(
    database: D1DatabaseBinding,
    migrations: D1Migration[],
  ): Promise<void>;
}
