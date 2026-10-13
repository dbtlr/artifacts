import { describe, expect, it } from 'vite-plus/test';

import { assertNoLegacyEnv } from './legacy-env.js';

describe('assertNoLegacyEnv', () => {
  it('accepts an environment without legacy variables', () => {
    expect(() => {
      assertNoLegacyEnv({ MUNINN_OWNER_PASSWORD: 'a long random password', PATH: '/bin' });
    }).not.toThrow();
  });

  it('refuses a legacy variable and names its replacement', () => {
    expect(() => {
      assertNoLegacyEnv({ ARTIFACTS_OWNER_PASSWORD: 'a long random password' });
    }).toThrow(/ARTIFACTS_OWNER_PASSWORD is no longer read; rename it to MUNINN_OWNER_PASSWORD/u);
  });

  it('refuses a legacy variable even when it is blank', () => {
    expect(() => {
      assertNoLegacyEnv({ ARTIFACTS_PORT: '' });
    }).toThrow(/ARTIFACTS_PORT .* MUNINN_PORT/u);
  });

  it('names every legacy variable at once', () => {
    expect(() => {
      assertNoLegacyEnv({ ARTIFACTS_PORT: '4242', ARTIFACTS_PUBLIC_BASE_URL: 'https://x.example' });
    }).toThrow(/ARTIFACTS_PORT[\s\S]*ARTIFACTS_PUBLIC_BASE_URL/u);
  });

  it('never repeats a legacy value', () => {
    expect(() => {
      assertNoLegacyEnv({ ARTIFACTS_OWNER_PASSWORD: 'correct horse battery staple' });
    }).toThrow(expect.objectContaining({ message: expect.not.stringContaining('horse') }));
  });
});
