import { afterEach, describe, expect, it } from 'vite-plus/test';

import { buildArtifactUrl } from './urls.js';

const originalArtifactsBaseUrl = process.env.ARTIFACTS_PUBLIC_BASE_URL;
const originalLegacyBaseUrl = process.env.PUBLIC_BASE_URL;

afterEach(() => {
  if (originalArtifactsBaseUrl === undefined) {
    delete process.env.ARTIFACTS_PUBLIC_BASE_URL;
  } else {
    process.env.ARTIFACTS_PUBLIC_BASE_URL = originalArtifactsBaseUrl;
  }
  if (originalLegacyBaseUrl === undefined) {
    delete process.env.PUBLIC_BASE_URL;
  } else {
    process.env.PUBLIC_BASE_URL = originalLegacyBaseUrl;
  }
});

describe('buildArtifactUrl', () => {
  it('defaults to localhost:3000 without honoring the removed legacy variable', () => {
    delete process.env.ARTIFACTS_PUBLIC_BASE_URL;
    process.env.PUBLIC_BASE_URL = 'https://legacy.example';

    expect(buildArtifactUrl('abc123')).toBe('http://localhost:3000/a/abc123');
  });

  it.each([
    '',
    '   ',
    'artifacts.example',
    'ftp://artifacts.example',
    'https://user:secret@artifacts.example',
    'https://artifacts.example/?token=secret',
    'https://artifacts.example/#section',
    'not a URL',
  ])('rejects an invalid ARTIFACTS_PUBLIC_BASE_URL value %j', (value) => {
    process.env.ARTIFACTS_PUBLIC_BASE_URL = value;

    expect(() => buildArtifactUrl('abc123')).toThrow(/ARTIFACTS_PUBLIC_BASE_URL/u);
  });
});
