import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ArtifactContentStore, ArtifactType } from '../artifacts/types.js';

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

export class FilesystemArtifactContentStore implements ArtifactContentStore {
  private readonly filesDir: string;

  constructor(filesDir: string) {
    this.filesDir = filesDir;
    mkdirSync(filesDir, { recursive: true });
  }

  private path(id: string, type: ArtifactType): string {
    return join(this.filesDir, `${id}.${type}`);
  }

  move(id: string, fromType: ArtifactType, toType: ArtifactType): void {
    renameSync(this.path(id, fromType), this.path(id, toType));
  }

  read(id: string, type: ArtifactType): Uint8Array {
    return readFileSync(this.path(id, type));
  }

  remove(id: string, type: ArtifactType): boolean {
    try {
      unlinkSync(this.path(id, type));
      return true;
    } catch (error) {
      if (isErrnoException(error) && error.code === 'ENOENT') {
        return false;
      }
      throw error;
    }
  }

  write(id: string, type: ArtifactType, content: Uint8Array): void {
    writeFileSync(this.path(id, type), content);
  }
}
