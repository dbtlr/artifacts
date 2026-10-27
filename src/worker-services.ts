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
import { legacyEnvNames } from './legacy-env.js';
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

// A Worker setting that is missing or invalid: the owner password, the
// public base URL, or variables under the old ARTIFACTS_ prefix (ADR-0007),
// listed in `legacyNames`. worker.ts turns it into the public error, which
// names the setting; the cause, which may hold the setting's value, is not
// shown or logged.
export class WorkerConfigError extends Error {
  readonly legacyNames: string[];
  readonly setting: 'ARTIFACTS_*' | 'MUNINN_OWNER_PASSWORD' | 'MUNINN_PUBLIC_BASE_URL';

  constructor(setting: WorkerConfigError['setting'], legacyNames: string[] = []) {
    super(`Invalid Worker setting ${setting}`);
    this.name = 'WorkerConfigError';
    this.legacyNames = legacyNames;
    this.setting = setting;
  }
}

// A checked setting, or undefined when the check fails. The error is
// dropped, because its message may include the value it checked.
function checked<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

// Checks the Worker's settings and returns the owner password. A Worker has
// no trusted network, so unlike Node it requires the password (ADR-0009).
// It also requires an explicit public base URL: Node's default follows
// MUNINN_PORT, which means nothing on a Worker. The checks are the shared
// ones from owner-auth.ts and urls.ts.
export function resolveWorkerConfig(env: WorkerEnv): { password: string } {
  const legacyNames = legacyEnvNames(env);
  if (legacyNames.length > 0) {
    throw new WorkerConfigError('ARTIFACTS_*', legacyNames);
  }
  const password = checked(() =>
    resolveOwnerPassword({ MUNINN_OWNER_PASSWORD: text(env.MUNINN_OWNER_PASSWORD) }),
  );
  if (password === undefined) {
    throw new WorkerConfigError('MUNINN_OWNER_PASSWORD');
  }
  const baseUrl = text(env.MUNINN_PUBLIC_BASE_URL);
  if (
    baseUrl === undefined ||
    checked(() => resolvePublicBaseUrl({ MUNINN_PUBLIC_BASE_URL: baseUrl })) === undefined
  ) {
    throw new WorkerConfigError('MUNINN_PUBLIC_BASE_URL');
  }
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
