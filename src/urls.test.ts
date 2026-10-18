import { afterEach, describe, expect, it } from 'vite-plus/test';

import { buildArtifactUrl } from './urls.js';

const originalArtifactsBaseUrl = process.env.MUNINN_PUBLIC_BASE_URL;
const originalLegacyBaseUrl = process.env.PUBLIC_BASE_URL;
const originalPort = process.env.MUNINN_PORT;

afterEach(() => {
  if (originalArtifactsBaseUrl === undefined) {
    delete process.env.MUNINN_PUBLIC_BASE_URL;
  } else {
    process.env.MUNINN_PUBLIC_BASE_URL = originalArtifactsBaseUrl;
  }
  if (originalLegacyBaseUrl === undefined) {
    delete process.env.PUBLIC_BASE_URL;
  } else {
    process.env.PUBLIC_BASE_URL = originalLegacyBaseUrl;
  }
  if (originalPort === undefined) {
    delete process.env.MUNINN_PORT;
  } else {
    process.env.MUNINN_PORT = originalPort;
  }
});

describe('buildArtifactUrl', () => {
  it('defaults to localhost:4243 without honoring the removed legacy variable', () => {
    delete process.env.MUNINN_PUBLIC_BASE_URL;
    delete process.env.MUNINN_PORT;
    process.env.PUBLIC_BASE_URL = 'https://legacy.example';

    expect(buildArtifactUrl('abc123')).toBe('http://localhost:4243/a/abc123');
  });

  it('follows MUNINN_PORT when no public base URL is set', () => {
    delete process.env.MUNINN_PUBLIC_BASE_URL;
    process.env.MUNINN_PORT = '5123';

    expect(buildArtifactUrl('abc123')).toBe('http://localhost:5123/a/abc123');
  });

  it('normalizes the default like an explicit base URL', () => {
    delete process.env.MUNINN_PUBLIC_BASE_URL;
    process.env.MUNINN_PORT = '80';

    expect(buildArtifactUrl('abc123')).toBe('http://localhost/a/abc123');
  });

  it('lets an explicit MUNINN_PUBLIC_BASE_URL win over MUNINN_PORT', () => {
    process.env.MUNINN_PUBLIC_BASE_URL = 'https://artifacts.example';
    process.env.MUNINN_PORT = '5123';

    expect(buildArtifactUrl('abc123')).toBe('https://artifacts.example/a/abc123');
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
  ])('rejects an invalid MUNINN_PUBLIC_BASE_URL value %j', (value) => {
    process.env.MUNINN_PUBLIC_BASE_URL = value;

    expect(() => buildArtifactUrl('abc123')).toThrow(/MUNINN_PUBLIC_BASE_URL/u);
  });
});
