import { createHmac, timingSafeEqual } from 'node:crypto';

import { isSafeId } from '../data/safe-id.js';

// How long a signed URL stays usable by default. It covers one thumbnail
// render, which the renderer caps at 15 s, with room to spare.
export const SIGNED_URL_LIFETIME_SECONDS = 60;

// How long the embedded URLs in a viewed HTML artifact stay usable. A page
// can load an embed well after it is served: a lazy image or frame loads
// when scrolled to. Reloading the page signs them again.
export const EMBED_URL_LIFETIME_SECONDS = 10 * 60;

// Unix seconds, digits only, so `123.0` or `+123` cannot pass for a
// signed `123`.
const EXPIRES = /^\d{1,12}$/u;

export type ArtifactUrlSigner = {
  // `/a/:id` with an expiry and a signature in its query. Until it expires,
  // `lifetimeSeconds` from now (the signer's lifetime when omitted), that URL
  // reads this one artifact without a session.
  signedPath: (id: string, lifetimeSeconds?: number) => string;
  // Whether `query` carries an unexpired signature from this signer for
  // reading artifact `id`.
  verify: (id: string, query: URLSearchParams) => boolean;
};

type ArtifactUrlSignerOptions = {
  // The HMAC key. It must be secret and random; anyone who holds it can read
  // any artifact.
  key: Uint8Array;
  lifetimeSeconds?: number;
  now?: () => Date;
};

// Short-lived capability URLs for one artifact each: the thumbnail renderer
// reads an artifact through one when owner auth is on, since it has no
// session, and so does a sandboxed HTML artifact for each artifact it
// embeds. A signature binds the artifact id and the expiry, so it cannot be
// moved to another artifact or extended. It knows nothing about HTTP:
// auth/routes.tsx decides which requests may use one.
export function createArtifactUrlSigner({
  key,
  lifetimeSeconds = SIGNED_URL_LIFETIME_SECONDS,
  now = () => new Date(),
}: ArtifactUrlSignerOptions): ArtifactUrlSigner {
  function signatureFor(id: string, expires: string): string {
    return createHmac('sha256', key).update(`artifact-read\n${id}\n${expires}`).digest('base64url');
  }

  function signedPath(id: string, lifetime = lifetimeSeconds): string {
    if (!isSafeId(id)) {
      throw new Error(`Cannot sign a URL for ${JSON.stringify(id)}: not an artifact id`);
    }
    const expires = String(Math.floor(now().getTime() / 1000) + lifetime);
    const query = new URLSearchParams({
      expires,
      signature: signatureFor(id, expires),
    });
    return `/a/${id}?${query.toString()}`;
  }

  function verify(id: string, query: URLSearchParams): boolean {
    const expires = query.get('expires');
    const signature = query.get('signature');
    if (expires === null || signature === null || !EXPIRES.test(expires) || !isSafeId(id)) {
      return false;
    }
    if (Number(expires) * 1000 <= now().getTime()) {
      return false;
    }
    // Compared as text, so a lenient base64 decoder cannot accept a
    // spelling of the signature that was never issued.
    const expected = Buffer.from(signatureFor(id, expires));
    const given = Buffer.from(signature);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  return { signedPath, verify };
}
