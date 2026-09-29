import type { ThumbnailStore } from '../thumbnails/types.js';
import { readObject } from './r2-bucket.js';
import type { R2BucketBinding } from './r2-bucket.js';
import { isSafeId } from './safe-id.js';

function keyFor(id: string): string {
  if (!isSafeId(id)) {
    throw new Error(`Invalid thumbnail id ${JSON.stringify(id)}`);
  }
  return `thumbs/${id}.jpg`;
}

// One JPEG per artifact as an R2 object keyed `thumbs/<id>.jpg`, the layout
// of the filesystem store's directory. The prefix keeps thumbnails apart from
// artifact content when both stores share a bucket. A put is atomic, so the
// /a/:id/thumb route can never serve a half-written image.
export class R2ThumbnailStore implements ThumbnailStore {
  private readonly bucket: R2BucketBinding;

  constructor(bucket: R2BucketBinding) {
    this.bucket = bucket;
  }

  async has(id: string): Promise<boolean> {
    return (await this.bucket.head(keyFor(id))) !== null;
  }

  async read(id: string): Promise<Uint8Array | null> {
    return readObject(this.bucket, keyFor(id));
  }

  // R2 deletes of a missing key succeed, so removal is already idempotent.
  async remove(id: string): Promise<void> {
    await this.bucket.delete(keyFor(id));
  }

  async write(id: string, bytes: Uint8Array): Promise<void> {
    await this.bucket.put(keyFor(id), bytes);
  }
}
