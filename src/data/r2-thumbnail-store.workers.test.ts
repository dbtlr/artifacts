import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vite-plus/test';

import { R2ArtifactContentStore } from './r2-artifact-content-store.js';
import { emptyBucket } from './r2-bucket.test-support.js';
import { R2ThumbnailStore } from './r2-thumbnail-store.js';
import { thumbnailStoreContract } from './thumbnail-store-contract.test-support.js';

beforeEach(() => emptyBucket(env.ARTIFACTS_BUCKET));

thumbnailStoreContract('r2', () => new R2ThumbnailStore(env.ARTIFACTS_BUCKET));

describe('R2ThumbnailStore', () => {
  it('shares a bucket with the content store without touching its objects', async () => {
    const content = new R2ArtifactContentStore(env.ARTIFACTS_BUCKET);
    const thumbnails = new R2ThumbnailStore(env.ARTIFACTS_BUCKET);
    await content.write('abc123', 'image/jpeg', Uint8Array.from([1]));
    await thumbnails.write('abc123', Uint8Array.from([2]));

    await thumbnails.remove('abc123');

    await expect(content.read('abc123', 'image/jpeg')).resolves.toEqual(Uint8Array.from([1]));
  });
});
