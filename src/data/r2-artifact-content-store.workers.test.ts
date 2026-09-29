import { env } from 'cloudflare:workers';
import { beforeEach } from 'vite-plus/test';

import { contentStoreContract } from './artifact-store-contract.test-support.js';
import { R2ArtifactContentStore } from './r2-artifact-content-store.js';
import { emptyBucket } from './r2-bucket.test-support.js';

beforeEach(() => emptyBucket(env.ARTIFACTS_BUCKET));

contentStoreContract('r2', () => new R2ArtifactContentStore(env.ARTIFACTS_BUCKET));
