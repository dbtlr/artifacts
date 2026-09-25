import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ThumbnailStore } from '../thumbnails/types.js';

// Artifact ids are nanoid output; anything else is refused before it can
// become a path segment, since the id reaches here from a URL parameter.
const SAFE_ID = /^[A-Za-z0-9_-]+$/u;

function pathFor(dir: string, id: string): string {
  if (!SAFE_ID.test(id)) {
    throw new Error(`Invalid thumbnail id ${JSON.stringify(id)}`);
  }
  return join(dir, `${id}.jpg`);
}

// One JPEG per artifact under `dir`, written atomically (temp file + rename)
// so the /a/:id/thumb route can never serve a half-written image.
export class FilesystemThumbnailStore implements ThumbnailStore {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  has(id: string): boolean {
    return existsSync(pathFor(this.dir, id));
  }

  // Read-then-check rather than check-then-read, so a remove landing between
  // the two cannot turn a missing file into a thrown error.
  read(id: string): Uint8Array | null {
    try {
      return new Uint8Array(readFileSync(pathFor(this.dir, id)));
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  remove(id: string): void {
    rmSync(pathFor(this.dir, id), { force: true });
  }

  write(id: string, bytes: Uint8Array): void {
    const path = pathFor(this.dir, id);
    mkdirSync(this.dir, { recursive: true });
    const temp = `${path}.${String(process.pid)}.tmp`;
    writeFileSync(temp, bytes);
    renameSync(temp, path);
  }
}
