import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vite-plus/test';

import { resolveStoragePaths } from './data-dir.js';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const developmentDataDir = join(projectRoot, 'data', 'development');

const defaults = {
  databasePath: join(developmentDataDir, 'database', 'artifacts.db'),
  filesDir: join(developmentDataDir, 'files'),
  thumbsDir: join(developmentDataDir, 'thumbs'),
};

describe('resolveStoragePaths', () => {
  it('defaults to isolated development locations without honoring the legacy variable', () => {
    const paths = resolveStoragePaths({ ARTIFACTS_DATA_DIR: '/legacy/production/data' });

    expect(paths).toEqual(defaults);
  });

  it('overrides the files directory without redirecting the others', () => {
    const paths = resolveStoragePaths({ ARTIFACTS_FILES_DIR: '/srv/artifacts/files' });

    expect(paths).toEqual({ ...defaults, filesDir: '/srv/artifacts/files' });
  });

  it('overrides the database path without redirecting the others', () => {
    const paths = resolveStoragePaths({ ARTIFACTS_DATABASE_PATH: '/srv/artifacts/metadata.db' });

    expect(paths).toEqual({ ...defaults, databasePath: '/srv/artifacts/metadata.db' });
  });

  it('overrides the thumbnails directory without redirecting the others', () => {
    const paths = resolveStoragePaths({ ARTIFACTS_THUMBS_DIR: '/srv/artifacts/thumbs' });

    expect(paths).toEqual({ ...defaults, thumbsDir: '/srv/artifacts/thumbs' });
  });

  it('trims surrounding whitespace from path overrides', () => {
    expect(
      resolveStoragePaths({
        ARTIFACTS_DATABASE_PATH: ' /srv/artifacts/metadata.db ',
        ARTIFACTS_FILES_DIR: ' /srv/artifacts/files ',
        ARTIFACTS_THUMBS_DIR: ' /srv/artifacts/thumbs ',
      }),
    ).toEqual({
      databasePath: '/srv/artifacts/metadata.db',
      filesDir: '/srv/artifacts/files',
      thumbsDir: '/srv/artifacts/thumbs',
    });
  });

  it.each(['ARTIFACTS_FILES_DIR', 'ARTIFACTS_DATABASE_PATH', 'ARTIFACTS_THUMBS_DIR'] as const)(
    'rejects a blank %s override',
    (name) => {
      expect(() => resolveStoragePaths({ [name]: '   ' })).toThrow(`${name} must not be blank`);
    },
  );
});
