import { mediaDefinition } from '../artifacts/media.js';
import type { ArtifactContentStore, MediaType } from '../artifacts/types.js';
import { readObject } from './r2-bucket.js';
import type { R2BucketBinding } from './r2-bucket.js';
import { isSafeId } from './safe-id.js';

// Artifact bytes as R2 objects keyed `files/<id>.<extension>`, the layout of
// the filesystem store's files directory. The prefix keeps them apart from
// thumbnails when both stores share a bucket. A put is atomic, so a reader
// sees either no object or the whole of it.
export class R2ArtifactContentStore implements ArtifactContentStore {
  private readonly bucket: R2BucketBinding;

  constructor(bucket: R2BucketBinding) {
    this.bucket = bucket;
  }

  private key(id: string, mediaType: MediaType): string {
    if (!isSafeId(id)) {
      throw new Error(
        `Invalid artifact id ${JSON.stringify(id)}: must be a plain filename segment`,
      );
    }
    return `files/${id}.${mediaDefinition(mediaType).extension}`;
  }

  async read(id: string, mediaType: MediaType): Promise<Uint8Array | null> {
    return readObject(this.bucket, this.key(id, mediaType));
  }

  // R2 deletes do not report whether an object existed, so this checks
  // first. Two removes racing on one object can both resolve true; the
  // service only removes content after it has removed the metadata row,
  // which settles the race.
  async remove(id: string, mediaType: MediaType): Promise<boolean> {
    const key = this.key(id, mediaType);
    if ((await this.bucket.head(key)) === null) {
      return false;
    }
    await this.bucket.delete(key);
    return true;
  }

  async write(id: string, mediaType: MediaType, content: Uint8Array): Promise<void> {
    await this.bucket.put(this.key(id, mediaType), content);
  }
}
