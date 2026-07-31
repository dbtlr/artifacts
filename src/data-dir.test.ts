import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vite-plus/test';

import { resolveStoragePaths } from './data-dir.js';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('resolveStoragePaths', () => {
  it('defaults to isolated development file and database locations without honoring the legacy variable', () => {
    const paths = resolveStoragePaths({ ARTIFACTS_DATA_DIR: '/legacy/production/data' });

    expect(paths).toEqual({
      databasePath: join(projectRoot, 'data', 'development', 'database', 'artifacts.db'),
      filesDir: join(projectRoot, 'data', 'development', 'files'),
    });
  });

  it('overrides the files directory without redirecting the database', () => {
    const paths = resolveStoragePaths({ ARTIFACTS_FILES_DIR: '/srv/artifacts/files' });

    expect(paths).toEqual({
      databasePath: join(projectRoot, 'data', 'development', 'database', 'artifacts.db'),
      filesDir: '/srv/artifacts/files',
    });
  });

  it('overrides the database path without redirecting artifact files', () => {
    const paths = resolveStoragePaths({ ARTIFACTS_DATABASE_PATH: '/srv/artifacts/metadata.db' });

    expect(paths).toEqual({
      databasePath: '/srv/artifacts/metadata.db',
      filesDir: join(projectRoot, 'data', 'development', 'files'),
    });
  });

  it.each(['ARTIFACTS_FILES_DIR', 'ARTIFACTS_DATABASE_PATH'] as const)(
    'rejects a blank %s override',
    (name) => {
      expect(() => resolveStoragePaths({ [name]: '   ' })).toThrow(`${name} must not be blank`);
    },
  );
});
