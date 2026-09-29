import { describe, expect, it } from 'vite-plus/test';

import { createArtifactUrlSigner, SIGNED_URL_LIFETIME_SECONDS } from './signed-urls.js';

const KEY = new Uint8Array(32).fill(7);
const SIGNED_AT = new Date('2026-09-29T12:00:00.000Z');

function signerAt(at: () => Date, key: Uint8Array = KEY) {
  return createArtifactUrlSigner({ key, now: at });
}

// The query of a signed path, as a request handler would see it.
function queryOf(path: string): URLSearchParams {
  return new URL(path, 'http://artifacts.invalid').searchParams;
}

describe('createArtifactUrlSigner', () => {
  it('signs a path to one artifact that verifies for that artifact', () => {
    const signer = signerAt(() => SIGNED_AT);

    const path = signer.signedPath('abc_123-XYZ');

    expect(path).toMatch(/^\/a\/abc_123-XYZ\?expires=\d+&signature=[\w-]+$/u);
    expect(signer.verify('abc_123-XYZ', queryOf(path))).toBe(true);
  });

  it('expires the signature after its lifetime', () => {
    let now = SIGNED_AT;
    const signer = signerAt(() => now);
    const query = queryOf(signer.signedPath('abc'));

    now = new Date(SIGNED_AT.getTime() + (SIGNED_URL_LIFETIME_SECONDS - 1) * 1000);
    expect(signer.verify('abc', query)).toBe(true);

    now = new Date(SIGNED_AT.getTime() + SIGNED_URL_LIFETIME_SECONDS * 1000);
    expect(signer.verify('abc', query)).toBe(false);
  });

  it('signs for a longer lifetime when asked to', () => {
    let now = SIGNED_AT;
    const signer = signerAt(() => now);
    const query = queryOf(signer.signedPath('abc', 600));

    now = new Date(SIGNED_AT.getTime() + 599 * 1000);
    expect(signer.verify('abc', query)).toBe(true);

    now = new Date(SIGNED_AT.getTime() + 600 * 1000);
    expect(signer.verify('abc', query)).toBe(false);
  });

  it('grants nothing for another artifact', () => {
    const signer = signerAt(() => SIGNED_AT);

    expect(signer.verify('other', queryOf(signer.signedPath('abc')))).toBe(false);
  });

  it('refuses a signature with a moved expiry, an altered signature, or a missing part', () => {
    const signer = signerAt(() => SIGNED_AT);
    const query = queryOf(signer.signedPath('abc'));
    const expires = query.get('expires')!;
    const signature = query.get('signature')!;
    const flipped = `${signature.slice(0, -1)}${signature.endsWith('A') ? 'B' : 'A'}`;

    const tampered: Record<string, string>[] = [
      { expires: String(Number(expires) + 3600), signature },
      { expires: `${expires}.0`, signature },
      { expires, signature: flipped },
      { expires, signature: signature.slice(0, -2) },
      { expires },
      { signature },
    ];

    for (const params of tampered) {
      expect(signer.verify('abc', new URLSearchParams(params))).toBe(false);
    }
  });

  it('refuses a signature made with another key', () => {
    const other = signerAt(() => SIGNED_AT, new Uint8Array(32).fill(8));

    expect(signerAt(() => SIGNED_AT).verify('abc', queryOf(other.signedPath('abc')))).toBe(false);
  });

  it('refuses to sign an id that is not an artifact id', () => {
    const signer = signerAt(() => SIGNED_AT);

    expect(() => signer.signedPath('../etc')).toThrow(/not an artifact id/u);
  });
});
