import { createArtifactService } from './artifacts/service.js';
import { createOwnerAuth, resolveOwnerPassword } from './auth/owner-auth.js';
import type { OwnerAuth } from './auth/owner-auth.js';
import { D1ArtifactMetadataStore } from './data/d1-artifact-metadata-store.js';
import type { D1DatabaseBinding } from './data/d1-database.js';
import { D1OwnerAuthStore } from './data/d1-owner-auth-store.js';
import { D1SecretStore } from './data/d1-secret-store.js';
import { R2ArtifactContentStore } from './data/r2-artifact-content-store.js';
import type { R2BucketBinding } from './data/r2-bucket.js';
import { R2ThumbnailStore } from './data/r2-thumbnail-store.js';
import { assertNoLegacyEnv } from './legacy-env.js';
import { createSecretService } from './secrets/service.js';
import type { SecretService } from './secrets/types.js';
import type { AppServices } from './services.js';
import { resolvePublicBaseUrl } from './urls.js';
import type { AssetsBinding } from './worker-static-files.js';

// The Worker's bindings, from wrangler.jsonc, and its settings, which are
// text bindings: vars and secrets. workerd also copies the text bindings into
// process.env, where the shared app reads the public base URL.
export type WorkerEnv = {
  ASSETS: AssetsBinding;
  MUNINN_BUCKET: R2BucketBinding;
  MUNINN_DB: D1DatabaseBinding;
  MUNINN_OWNER_PASSWORD?: unknown;
  MUNINN_PUBLIC_BASE_URL?: unknown;
};

// Cloudflare sets this header to the client's address itself, so the
// per-client login limit (ADR-0005) needs no operator setting here.
const CLIENT_ADDRESS_HEADER = 'cf-connecting-ip';

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

// Checks the Worker's settings and returns the owner password. A Worker has
// no trusted network, so unlike Node it requires the password (ADR-0009).
// It also requires an explicit public base URL: Node's default follows
// MUNINN_PORT, which means nothing on a Worker. Each error names its setting
// and never includes a secret's value.
export function resolveWorkerConfig(env: WorkerEnv): { password: string } {
  assertNoLegacyEnv(env);
  const password = resolveOwnerPassword({ MUNINN_OWNER_PASSWORD: text(env.MUNINN_OWNER_PASSWORD) });
  if (password === undefined) {
    throw new Error(
      'MUNINN_OWNER_PASSWORD must be set; set it with `wrangler secret put MUNINN_OWNER_PASSWORD`',
    );
  }
  const baseUrl = text(env.MUNINN_PUBLIC_BASE_URL);
  if (baseUrl === undefined) {
    throw new Error('MUNINN_PUBLIC_BASE_URL must be set to the URL the Worker is reached at');
  }
  resolvePublicBaseUrl({ MUNINN_PUBLIC_BASE_URL: baseUrl });
  return { password };
}

export type WorkerServices = AppServices & { auth: OwnerAuth; secrets: SecretService };

// The Worker's composition root: the shared services on D1 and R2, with
// owner auth always on. Gallery previews stay placeholders: nothing renders
// them on the Worker yet, so the thumbnail store is only read.
export function createWorkerServices(env: WorkerEnv): WorkerServices {
  const { password } = resolveWorkerConfig(env);
  const auth = createOwnerAuth({
    clientAddressHeader: CLIENT_ADDRESS_HEADER,
    password,
    store: new D1OwnerAuthStore(env.MUNINN_DB),
  });
  const artifacts = createArtifactService(
    new D1ArtifactMetadataStore(env.MUNINN_DB, env.MUNINN_BUCKET),
    new R2ArtifactContentStore(env.MUNINN_BUCKET),
  );
  return {
    artifacts,
    auth,
    mcp: artifacts,
    secrets: createSecretService({ store: new D1SecretStore(env.MUNINN_DB) }),
    thumbnails: new R2ThumbnailStore(env.MUNINN_BUCKET),
  };
}
