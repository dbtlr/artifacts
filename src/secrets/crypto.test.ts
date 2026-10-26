import { describe, expect, it } from 'vite-plus/test';

import {
  decodeKey,
  decrypt,
  deriveClaimKey,
  encrypt,
  fromBase64Url,
  hashToken,
  toBase64Url,
} from './crypto.js';

const key = new Uint8Array(32).map((_byte, index) => index);
const nonce = new Uint8Array(12).fill(9);
const plaintext = new TextEncoder().encode('secret bytes');

describe('secret crypto', () => {
  it('round-trips bytes through base64url', () => {
    const bytes = Uint8Array.from([0, 251, 255, 62, 63]);

    expect(toBase64Url(bytes)).toBe('APv_Pj8');
    expect(fromBase64Url('APv_Pj8')).toEqual(bytes);
  });

  it.each(['APv/Pj8', 'APv_Pj8=', 'APv_Pj9', 'A', ' APv_Pj8'])(
    'refuses %j as base64url',
    (text) => {
      expect(fromBase64Url(text)).toBeNull();
    },
  );

  it('decodes only 256-bit keys', () => {
    expect(decodeKey(toBase64Url(key))).toEqual(key);
    expect(decodeKey(toBase64Url(key.slice(1)))).toBeNull();
    expect(decodeKey(toBase64Url(new Uint8Array(33)))).toBeNull();
  });

  it('decrypts only with the key and associated data it encrypted with', async () => {
    const ciphertext = await encrypt(key, nonce, 'secret-id', plaintext);

    expect(toBase64Url(ciphertext)).not.toContain(toBase64Url(plaintext));
    await expect(decrypt(key, nonce, 'secret-id', ciphertext)).resolves.toEqual(plaintext);
    await expect(decrypt(key, nonce, 'other-id', ciphertext)).resolves.toBeNull();
    await expect(decrypt(new Uint8Array(32), nonce, 'secret-id', ciphertext)).resolves.toBeNull();
    const tampered = Uint8Array.from(ciphertext);
    tampered[0] = (tampered[0] ?? 0) ^ 1;
    await expect(decrypt(key, nonce, 'secret-id', tampered)).resolves.toBeNull();
  });

  it('derives a claim key that differs from the token and its hash', async () => {
    const token = toBase64Url(key);

    const derived = await deriveClaimKey(key);

    expect(derived).toHaveLength(32);
    expect(derived).not.toEqual(key);
    expect(toBase64Url(derived)).not.toBe(token);
    await expect(deriveClaimKey(key)).resolves.toEqual(derived);
    await expect(hashToken(token)).resolves.toMatch(/^[0-9a-f]{64}$/u);
    expect(Buffer.from(derived).toString('hex')).not.toBe(await hashToken(token));
  });
});
