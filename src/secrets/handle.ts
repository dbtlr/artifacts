import { decodeKey, fromBase64Url } from './crypto.js';

// Secret ids are 128 random bits in base64url: the safe-id alphabet (see
// data/safe-id.ts), which has no `.`, so a handle splits in one place.
const ID_BYTES = 16;
const HANDLE = /^sec_([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/u;

// Whether `id` is the canonical base64url spelling of 128 bits, so each
// secret has exactly one id text.
export function isSecretId(id: string): boolean {
  return fromBase64Url(id)?.length === ID_BYTES;
}

// The owner's handle for a secret, `sec_<id>.<key>`, which the agent redeems
// with a claim.
export function formatHandle(id: string, key: string): string {
  if (!isSecretId(id) || decodeKey(key) === null) {
    throw new Error('A secret handle needs a secret id and a 256-bit base64url key');
  }
  return `sec_${id}.${key}`;
}

// The id and key in a handle, or null for anything that is not exactly one.
export function parseHandle(handle: string): { id: string; key: string } | null {
  const match = HANDLE.exec(handle);
  const [, id, key] = match ?? [];
  return id === undefined || key === undefined || !isSecretId(id) || decodeKey(key) === null
    ? null
    : { id, key };
}
