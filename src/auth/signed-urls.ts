import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { isSafeId } from '../data/safe-id.js';
import type { UrlSigningKeyStore } from './types.js';

// How long a signed URL stays usable by default. It covers one thumbnail
// render, which the renderer caps at 15 s, with room to spare.
export const SIGNED_URL_LIFETIME_SECONDS = 60;

// Each clock hour has its own signing key. A URL verifies only against the
// current hour's key and the previous hour's, so none outlives about two
// hours, whatever its expiry says. A lifetime over an hour can be cut short.
export const SIGNING_KEY_BUCKET_SECONDS = 60 * 60;

export type SignedPathOptions = {
  // The least time the URL stays usable. The signer's lifetime when omitted.
  lifetimeSeconds?: number;
  // Signings in the same clock window of this many seconds get the same
  // expiry, and so the same URL: the expiry is rounded up to a window
  // boundary that leaves every signing in the window its whole lifetime.
  // Divides an hour, so a window never spans two signing keys.
  expiryWindowSeconds?: number;
};

// How the embedded URLs in a viewed HTML artifact expire. A page can load an
// embed well after it is served: a lazy image or frame loads when scrolled
// to. Views in the same five minutes get the same URLs, so the browser can
// reuse what it cached; each URL lasts 10 to 15 minutes. Reloading the page
// after that signs them again.
export const EMBED_URL_EXPIRY = {
  expiryWindowSeconds: 5 * 60,
  lifetimeSeconds: 10 * 60,
} as const satisfies SignedPathOptions;

// Unix seconds, digits only, so `123.0` or `+123` cannot pass for a
// signed `123`.
const EXPIRES = /^\d{1,12}$/u;

export type ArtifactUrlSigner = {
  // `/a/:id` with an expiry and a signature in its query. Until it expires,
  // at least `lifetimeSeconds` from now, that URL reads this one artifact
  // without a session.
  signedPath: (id: string, options?: SignedPathOptions) => Promise<string>;
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

// Unix seconds. Without a window, `lifetime` after `nowSeconds`. With one, the
// first window boundary at least `lifetime` after the end of the current
// window, so the whole window shares it.
function expiryFor(nowSeconds: number, lifetime: number, window?: number): number {
  if (window === undefined) {
    return nowSeconds + lifetime;
  }
  return (Math.floor(nowSeconds / window) + 1 + Math.ceil(lifetime / window)) * window;
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
// verifies alike. A stored key never changes, and no key is made for an
// hour that has passed, so the signer keeps what it learns about the hours
// it can still use in memory and reads the database about once an hour.
// Until a process signs in a new hour, a check also looks for that hour's
// key in the database.
export function createArtifactUrlSigner({
  keys,
  lifetimeSeconds = SIGNED_URL_LIFETIME_SECONDS,
  now = () => new Date(),
}: ArtifactUrlSignerOptions): ArtifactUrlSigner {
  // Kept as promises, so signers in this process that need a new key at
  // once share one trip to the database. A failed trip is not kept. Null
  // means a past hour that has no key.
  const known = new Map<number, Promise<Buffer | null>>();

  function currentBucket(): number {
    return Math.floor(now().getTime() / 1000 / SIGNING_KEY_BUCKET_SECONDS);
  }

  function remember<Key extends Buffer | null>(bucket: number, key: Promise<Key>): Promise<Key> {
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
  async function signingKey(bucket: number): Promise<Buffer> {
    const key = await (known.get(bucket) ?? remember(bucket, createKey(bucket)));
    // A cached miss for this bucket means the clock went back an hour.
    return key ?? remember(bucket, createKey(bucket));
  }

  // The bucket's key, or null when nothing was signed in that hour.
  async function verifyingKey(bucket: number): Promise<Buffer | null> {
    const hit = known.get(bucket);
    if (hit !== undefined) {
      return hit;
    }
    // Judged before the read: an hour that ends during it can still gain a
    // key that the read missed.
    const hourIsOver = bucket < currentBucket();
    const stored = await keys.findUrlSigningKey(bucket);
    if (stored !== null) {
      return remember(bucket, Promise.resolve(decodeKey(stored)));
    }
    // A current hour can still get a key; a past hour cannot.
    return hourIsOver ? remember(bucket, Promise.resolve(null)) : null;
  }

  async function signedPath(
    id: string,
    { lifetimeSeconds: lifetime = lifetimeSeconds, expiryWindowSeconds }: SignedPathOptions = {},
  ): Promise<string> {
    if (!isSafeId(id)) {
      throw new Error(`Cannot sign a URL for ${JSON.stringify(id)}: not an artifact id`);
    }
    // One clock reading for both the key's hour and the expiry: reading the
    // key can cross the hour, and a second reading would pair the old hour's
    // key with the next window's expiry, so views would stop sharing a URL.
    const nowSeconds = Math.floor(now().getTime() / 1000);
    const key = await signingKey(Math.floor(nowSeconds / SIGNING_KEY_BUCKET_SECONDS));
    const expires = String(expiryFor(nowSeconds, lifetime, expiryWindowSeconds));
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
