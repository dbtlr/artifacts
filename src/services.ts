import type { ArtifactService } from './artifacts/types.js';
import {
  createOwnerAuth,
  resolveClientAddressHeader,
  resolveOwnerPassword,
} from './auth/owner-auth.js';
import type { OwnerAuth } from './auth/owner-auth.js';
import { resolveStoragePaths } from './data-dir.js';
import { FilesystemThumbnailStore } from './data/filesystem-thumbnail-store.js';
import { SqliteOwnerAuthStore } from './data/sqlite-owner-auth-store.js';
import { getDefaultByteNativeArtifactService } from './data/store.js';
import { createThumbnailQueue } from './thumbnails/queue.js';
import type { ThumbnailQueue } from './thumbnails/queue.js';
import type { ThumbnailStore } from './thumbnails/types.js';
import { withThumbnails } from './thumbnails/with-thumbnails.js';

// What createApp needs. `thumbnails` is optional so an embedding caller (or a
// test) that has no preview store still gets placeholder images. `auth` is
// present only when an owner password is configured; without it the app has
// no login and serves every route to anyone who can reach it.
export type AppServices = {
  artifacts: ArtifactService;
  auth?: OwnerAuth;
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
    const password = resolveOwnerPassword();
    const base = await getDefaultByteNativeArtifactService();
    const paths = resolveStoragePaths();
    // The client address header is read only with auth on, so without a
    // password the variable has no effect at all.
    const clientAddressHeader = password === undefined ? undefined : resolveClientAddressHeader();
    const auth =
      password === undefined
        ? undefined
        : createOwnerAuth({
            ...(clientAddressHeader === undefined ? {} : { clientAddressHeader }),
            password,
            store: await SqliteOwnerAuthStore.open(paths.databasePath),
          });
    const thumbnails = new FilesystemThumbnailStore(paths.thumbsDir);
    // With auth on, the renderer has no session, so it reads each artifact
    // through a signed URL made for that render.
    const thumbnailQueue = createThumbnailQueue({
      ...(auth === undefined ? {} : { artifactPath: auth.artifactUrls.signedPath }),
      lookup: base.findArtifact,
      store: thumbnails,
    });
    const artifacts = withThumbnails(base, {
      enqueue: thumbnailQueue.enqueue,
      remove: (id) => thumbnails.remove(id),
    });
    return {
      artifacts,
      ...(auth === undefined ? {} : { auth }),
      mcp: artifacts,
      thumbnailQueue,
      thumbnails,
    };
  } catch (error) {
    defaultServices = undefined;
    throw error;
  }
}

// The one composition root for the process: the sqlite-backed artifact
// service wrapped with preview bookkeeping. server.ts awaits this up front,
// passes it to createApp, and starts the queue once the port is known. The
// memo exists for app.tsx's argument-less `createApp()` (the embedding and
// test default), which resolves the same services lazily; a caller on that
// path never calls `thumbnailQueue.start`, so there queued ids simply wait
// and cards keep their placeholders.
export function getDefaultAppServices(): Promise<DefaultAppServices> {
  defaultServices ??= createDefaultAppServices();
  return defaultServices;
}
