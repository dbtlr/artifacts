// The cryptography behind one-time secrets, on WebCrypto so it runs alike on
// Node and Workers. Keys, nonces, and tokens are random bytes the caller
// supplies, so tests can fix them.

const KEY_BYTES = 32;
const CLAIM_KEY_INFO = new TextEncoder().encode('muninn secret claim key');

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCodePoint(byte);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

// Decodes unpadded base64url, or resolves null for anything else. Only the
// canonical spelling of each value is accepted, so a key or token has exactly
// one text form.
export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/u.test(text) || text.length % 4 === 1) {
    return null;
  }
  const padded = text
    .replaceAll('-', '+')
    .replaceAll('_', '/')
    .padEnd(Math.ceil(text.length / 4) * 4, '=');
  const bytes = Uint8Array.from(atob(padded), (character) => character.codePointAt(0) ?? 0);
  return toBase64Url(bytes) === text ? bytes : null;
}

// A 256-bit key or token from its base64url text, or null.
export function decodeKey(text: string): Uint8Array<ArrayBuffer> | null {
  const bytes = fromBase64Url(text);
  return bytes?.length === KEY_BYTES ? bytes : null;
}

// Tokens are 256 random bits, so an unkeyed SHA-256 is enough to keep a copy
// of the database from holding usable tokens.
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function aesKey(key: Uint8Array<ArrayBuffer>, usage: 'decrypt' | 'encrypt'): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', key, 'AES-GCM', false, [usage]);
}

// AES-256-GCM with `associated` bound as additional authenticated data, so a
// ciphertext moved to another secret's row no longer decrypts.
export async function encrypt(
  key: Uint8Array<ArrayBuffer>,
  nonce: Uint8Array<ArrayBuffer>,
  associated: string,
  plaintext: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  const ciphertext = await crypto.subtle.encrypt(
    { additionalData: new TextEncoder().encode(associated), iv: nonce, name: 'AES-GCM' },
    await aesKey(key, 'encrypt'),
    plaintext,
  );
  return new Uint8Array(ciphertext);
}

// The plaintext, or null when the key, nonce, associated data, or ciphertext
// is not the one it was encrypted with.
export async function decrypt(
  key: Uint8Array<ArrayBuffer>,
  nonce: Uint8Array<ArrayBuffer>,
  associated: string,
  ciphertext: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer> | null> {
  try {
    const plaintext = await crypto.subtle.decrypt(
      { additionalData: new TextEncoder().encode(associated), iv: nonce, name: 'AES-GCM' },
      await aesKey(key, 'decrypt'),
      ciphertext,
    );
    return new Uint8Array(plaintext);
  } catch {
    return null;
  }
}

// The key that wraps a secret's data key under a claim, derived from the
// claim token with HKDF-SHA-256. The store keeps the token's SHA-256, which
// says nothing about this key.
export async function deriveClaimKey(
  claimToken: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  const material = await crypto.subtle.importKey('raw', claimToken, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { hash: 'SHA-256', info: CLAIM_KEY_INFO, name: 'HKDF', salt: new Uint8Array() },
    material,
    KEY_BYTES * 8,
  );
  return new Uint8Array(bits);
}
