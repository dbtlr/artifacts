import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { isSafeId } from '../data/safe-id.js';
import type { UrlSigningKeyStore } from './types.js';

// How long a signed URL stays usable by default. It covers one thumbnail
// render, which the renderer caps at 15 s, with room to spare.
export const SIGNED_URL_LIFETIME_SECONDS = 60;

// How long the embedded URLs in a viewed HTML artifact stay usable. A page
// can load an embed well after it is served: a lazy image or frame loads
// when scrolled to. Reloading the page signs them again.
export const EMBED_URL_LIFETIME_SECONDS = 10 * 60;

// Each clock hour has its own signing key. A URL verifies only against the
// current hour's key and the previous hour's, so none outlives about two
// hours, whatever its expiry says. A lifetime over an hour can be cut short.
export const SIGNING_KEY_BUCKET_SECONDS = 60 * 60;

// Unix seconds, digits only, so `123.0` or `+123` cannot pass for a
// signed `123`.
const EXPIRES = /^\d{1,12}$/u;

export type ArtifactUrlSigner = {
  // `/a/:id` with an expiry and a signature in its query. Until it expires,
  // `lifetimeSeconds` from now (the signer's lifetime when omitted), that URL
  // reads this one artifact without a session.
  signedPath: (id: string, lifetimeSeconds?: number) => Promise<string>;
  // Whether `query` carries an unexpired signature for reading artifact `id`,
  // made with this hour's key or the previous hour's.
  verify: (id: string, query: URLSearchParams) => Promise<boolean>;
};

type ArtifactUrlSignerOptions = {
  // Where the hourly keys live. Anyone who reads a current key can read any
  // artifact until that key is two hours old.
  keys: UrlSigningKeyStore;
  lifetimeSeconds?: number;
  now?: () => Date;
};

function decodeKey(key: string): Buffer {
  return Buffer.from(key, 'base64url');
}

function signatureFor(key: Buffer, id: string, expires: string): string {
  return createHmac('sha256', key).update(`artifact-read\n${id}\n${expires}`).digest('base64url');
}

// Short-lived capability URLs for one artifact each: the thumbnail renderer
// reads an artifact through one when owner auth is on, since it has no
// session, and so does a sandboxed HTML artifact for each artifact it
// embeds. A signature binds the artifact id and the expiry, so it cannot be
// moved to another artifact or extended. It knows nothing about HTTP:
// auth/routes.tsx decides which requests may use one.
//
// Keys live in the database, so every process that shares it signs and
// verifies alike. A stored key never changes, so the signer keeps the keys
// it can still use in memory and reads the database about once an hour.
export function createArtifactUrlSigner({
  keys,
  lifetimeSeconds = SIGNED_URL_LIFETIME_SECONDS,
  now = () => new Date(),
}: ArtifactUrlSignerOptions): ArtifactUrlSigner {
  // Kept as promises, so signers in this process that need a new key at
  // once share one trip to the database. A failed trip is not kept.
  const known = new Map<number, Promise<Buffer>>();

  function currentBucket(): number {
    return Math.floor(now().getTime() / 1000 / SIGNING_KEY_BUCKET_SECONDS);
  }

  function remember(bucket: number, key: Promise<Buffer>): Promise<Buffer> {
    for (const old of known.keys()) {
      if (old < bucket - 1) {
        known.delete(old);
      }
    }
    known.set(bucket, key);
    return key;
  }

  async function createKey(bucket: number): Promise<Buffer> {
    try {
      return decodeKey(
        await keys.createUrlSigningKey(bucket, randomBytes(32).toString('base64url')),
      );
    } catch (error) {
      known.delete(bucket);
      throw error;
    }
  }

  // The bucket's key, made now when no process has made it yet.
  function signingKey(bucket: number): Promise<Buffer> {
    return known.get(bucket) ?? remember(bucket, createKey(bucket));
  }

  // The bucket's key, or null when nothing was signed in that hour.
  async function verifyingKey(bucket: number): Promise<Buffer | null> {
    const hit = known.get(bucket);
    if (hit !== undefined) {
      return hit;
    }
    const stored = await keys.findUrlSigningKey(bucket);
    return stored === null ? null : remember(bucket, Promise.resolve(decodeKey(stored)));
  }

  async function signedPath(id: string, lifetime = lifetimeSeconds): Promise<string> {
    if (!isSafeId(id)) {
      throw new Error(`Cannot sign a URL for ${JSON.stringify(id)}: not an artifact id`);
    }
    const key = await signingKey(currentBucket());
    const expires = String(Math.floor(now().getTime() / 1000) + lifetime);
    const query = new URLSearchParams({
      expires,
      signature: signatureFor(key, id, expires),
    });
    return `/a/${id}?${query.toString()}`;
  }

  async function verify(id: string, query: URLSearchParams): Promise<boolean> {
    const expires = query.get('expires');
    const signature = query.get('signature');
    if (expires === null || signature === null || !EXPIRES.test(expires) || !isSafeId(id)) {
      return false;
    }
    if (Number(expires) * 1000 <= now().getTime()) {
      return false;
    }
    const bucket = currentBucket();
    const candidates = await Promise.all([verifyingKey(bucket), verifyingKey(bucket - 1)]);
    // Compared as text, so a lenient base64 decoder cannot accept a
    // spelling of the signature that was never issued.
    const given = Buffer.from(signature);
    return candidates.some((key) => {
      if (key === null) {
        return false;
      }
      const expected = Buffer.from(signatureFor(key, id, expires));
      return given.length === expected.length && timingSafeEqual(given, expected);
    });
  }

  return { signedPath, verify };
}
