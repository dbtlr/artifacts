import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ArtifactContentStore, ArtifactType } from '../artifacts/types.js';

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

const SAFE_ARTIFACT_ID = /^[A-Za-z0-9_-]+$/u;

export class FilesystemArtifactContentStore implements ArtifactContentStore {
  private readonly filesDir: string;

  constructor(filesDir: string) {
    this.filesDir = filesDir;
    mkdirSync(filesDir, { recursive: true });
  }

  private path(id: string, type: ArtifactType): string {
    if (!SAFE_ARTIFACT_ID.test(id)) {
      throw new Error(
        `Invalid artifact id ${JSON.stringify(id)}: must be a plain filename segment`,
      );
    }
    return join(this.filesDir, `${id}.${type}`);
  }

  private removePath(path: string): boolean {
    try {
      unlinkSync(path);
      return true;
    } catch (error) {
      if (isErrnoException(error) && error.code === 'ENOENT') {
        return false;
      }
      throw error;
    }
  }

  move(id: string, fromType: ArtifactType, toType: ArtifactType): void {
    renameSync(this.path(id, fromType), this.path(id, toType));
  }

  read(id: string, type: ArtifactType): Uint8Array {
    return readFileSync(this.path(id, type));
  }

  remove(id: string, type: ArtifactType): boolean {
    return this.removePath(this.path(id, type));
  }

  write(id: string, type: ArtifactType, content: Uint8Array): void {
    const target = this.path(id, type);
    const temporary = `${target}.${process.pid.toString()}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, content);
      renameSync(temporary, target);
    } catch (error) {
      try {
        this.removePath(temporary);
      } catch {
        // Cleanup failure must not hide the write/rename error.
      }
      throw error;
    }
  }
}
