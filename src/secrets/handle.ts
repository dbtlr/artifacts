import { decodeKey } from './crypto.js';

// Secret ids are 128 random bits in base64url: the safe-id alphabet (see
// data/safe-id.ts), which has no `.`, so a handle splits in one place.
const SECRET_ID = /^[A-Za-z0-9_-]{22}$/u;
const HANDLE = /^sec_([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/u;

export function isSecretId(id: string): boolean {
  return SECRET_ID.test(id);
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
  return id === undefined || key === undefined || decodeKey(key) === null ? null : { id, key };
}
