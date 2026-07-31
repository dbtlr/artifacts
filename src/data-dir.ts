import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Mirrors src/app.tsx's STATIC_ROOT resolution: both the dev entry (this
// module) and the packed bundle (dist/server.js) live exactly one directory
// below the repo root. Kept out of src/data/ because tsdown collapses deeper
// module nesting in the bundle.
const moduleDir = dirname(fileURLToPath(import.meta.url));
const developmentDataDir = join(moduleDir, '..', 'data', 'development');

export type StoragePaths = { databasePath: string; filesDir: string };

function resolvePathOverride(
  name: 'ARTIFACTS_DATABASE_PATH' | 'ARTIFACTS_FILES_DIR',
  value: string | undefined,
  fallback: string,
): string {
  if (value === undefined) {
    return fallback;
  }
  if (value.trim() === '') {
    throw new Error(`${name} must not be blank`);
  }
  return value;
}

export function resolveStoragePaths(env: NodeJS.ProcessEnv = process.env): StoragePaths {
  return {
    databasePath: resolvePathOverride(
      'ARTIFACTS_DATABASE_PATH',
      env.ARTIFACTS_DATABASE_PATH,
      join(developmentDataDir, 'database', 'artifacts.db'),
    ),
    filesDir: resolvePathOverride(
      'ARTIFACTS_FILES_DIR',
      env.ARTIFACTS_FILES_DIR,
      join(developmentDataDir, 'files'),
    ),
  };
}
