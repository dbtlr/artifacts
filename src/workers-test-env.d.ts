// Types for the bindings that the `workers` test project in vite.config.ts
// gives to `*.workers.test.ts` files. Only the parts those tests use are
// declared, because the full Workers runtime types clash with the DOM lib.
declare module 'cloudflare:workers' {
  import type { ListableR2Bucket } from './data/r2-bucket.test-support.js';

  export const env: { ARTIFACTS_BUCKET: ListableR2Bucket };
}
