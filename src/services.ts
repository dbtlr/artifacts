import type { ArtifactService } from './artifacts/types.js';
import { resolveStoragePaths } from './data-dir.js';
import { FilesystemThumbnailStore } from './data/filesystem-thumbnail-store.js';
import { getDefaultByteNativeArtifactService } from './data/store.js';
import { createThumbnailQueue } from './thumbnails/queue.js';
import type { ThumbnailQueue } from './thumbnails/queue.js';
import type { ThumbnailStore } from './thumbnails/types.js';
import { withThumbnails } from './thumbnails/with-thumbnails.js';

// What createApp needs. `thumbnails` is optional so an embedding caller (or a
// test) that has no preview store still gets placeholder images.
export type AppServices = {
  artifacts: ArtifactService;
  mcp: ArtifactService;
  thumbnails?: ThumbnailStore;
};

export type DefaultAppServices = AppServices & {
  thumbnailQueue: ThumbnailQueue;
  thumbnails: ThumbnailStore;
};

let defaultServices: Promise<DefaultAppServices> | undefined;

async function createDefaultAppServices(): Promise<DefaultAppServices> {
  try {
    const base = await getDefaultByteNativeArtifactService();
    const thumbnails = new FilesystemThumbnailStore(resolveStoragePaths().thumbsDir);
    const thumbnailQueue = createThumbnailQueue({ lookup: base.findArtifact, store: thumbnails });
    const artifacts = withThumbnails(base, {
      enqueue: thumbnailQueue.enqueue,
      remove: (id) => {
        thumbnails.remove(id);
      },
    });
    return { artifacts, mcp: artifacts, thumbnailQueue, thumbnails };
  } catch (error) {
    defaultServices = undefined;
    throw error;
  }
}

// The one composition root for the process: the sqlite-backed artifact
// service wrapped with preview bookkeeping. Memoized so the app's lazy first
// request and server.ts (which starts the queue once the port is known) share
// the same queue. Rendering does not begin until server.ts calls
// `thumbnailQueue.start`; until then queued ids simply wait.
export function getDefaultAppServices(): Promise<DefaultAppServices> {
  defaultServices ??= createDefaultAppServices();
  return defaultServices;
}
