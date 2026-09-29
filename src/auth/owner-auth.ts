import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { createArtifactUrlSigner } from './signed-urls.js';
import type { ArtifactUrlSigner } from './signed-urls.js';
import type { ApiKeySummary, LoginAttemptCount, OwnerAuthStore } from './types.js';

// A session lasts a fixed 7 days from login; using it does not extend it.
export const SESSION_LIFETIME_SECONDS = 7 * 24 * 60 * 60;
// At most LOGIN_ATTEMPT_LIMIT login attempts, right or wrong, from one client
// address in any rolling window, so one address cannot lock the owner out
// from another. LOGIN_ATTEMPT_TOTAL_LIMIT caps every address together, which
// bounds guesses from many addresses to under 10,000 a day (ADR-0005).
export const LOGIN_ATTEMPT_LIMIT = 10;
export const LOGIN_ATTEMPT_TOTAL_LIMIT = 100;
export const LOGIN_ATTEMPT_WINDOW_SECONDS = 15 * 60;
// With guesses bounded as above, a password of this many characters cannot
// be guessed online.
export const OWNER_PASSWORD_MIN_LENGTH = 16;
// A key's last use is written at most once in this many seconds, so a busy
// agent does not write to the database on every /mcp request.
export const API_KEY_USE_RESOLUTION_SECONDS = 60;

export type LoginResult =
  | { ok: true; token: string }
  | { ok: false; reason: 'incorrect-password' }
  | { ok: false; reason: 'rate-limited'; retryAfterSeconds: number };

// A new key's secret, which exists only in this value: the store keeps a hash.
export type CreatedApiKey = { id: string; key: string };

export type OwnerAuth = {
  // Signed URLs that read one artifact without a session, for the thumbnail
  // renderer and for the artifacts an HTML artifact embeds. Their keys are
  // random, one per hour, and kept in the store, so every process that
  // shares the database accepts them and no signature can reveal anything
  // about the password.
  artifactUrls: ArtifactUrlSigner;
  // The request header that a trusted proxy sets to the client's address,
  // as the operator named it, or undefined when none is named.
  clientAddressHeader: string | undefined;
  createApiKey: (name: string) => Promise<CreatedApiKey>;
  // Whether the key opens /mcp. A key that does is recorded as used now.
  hasApiKey: (key: string | undefined) => Promise<boolean>;
  hasSession: (token: string | undefined) => Promise<boolean>;
  listApiKeys: () => Promise<ApiKeySummary[]>;
  // `clientAddress` is the address the attempt counts against, or empty
  // when it is unknown.
  logIn: (password: string, clientAddress: string) => Promise<LoginResult>;
  logOut: (token: string | undefined) => Promise<void>;
  revokeApiKey: (id: string) => Promise<void>;
  // The recovery path after a suspected leak, since a new password keeps keys.
  revokeAllApiKeys: () => Promise<void>;
};

// Keys read `art_` and 256 random bits, so a leaked key is recognizable.
const API_KEY_PREFIX = 'art_';

type OwnerAuthOptions = {
  clientAddressHeader?: string;
  now?: () => Date;
  password: string;
  store: OwnerAuthStore;
};

// Owner auth is on exactly when ARTIFACTS_OWNER_PASSWORD is set. A blank
// value is refused rather than read as "off", so a half-written secret
// cannot silently leave an instance open. A short one is refused because the
// login limits bound guesses, not their success.
export function resolveOwnerPassword(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const password = env.ARTIFACTS_OWNER_PASSWORD;
  if (password === undefined) {
    return undefined;
  }
  if (password.trim() === '') {
    throw new Error('ARTIFACTS_OWNER_PASSWORD must not be blank; unset it to turn auth off');
  }
  // Characters as a reader sees them, so an emoji counts once.
  if ([...new Intl.Segmenter().segment(password)].length < OWNER_PASSWORD_MIN_LENGTH) {
    throw new Error(
      `ARTIFACTS_OWNER_PASSWORD must be at least ${String(OWNER_PASSWORD_MIN_LENGTH)} characters; use a long, random password`,
    );
  }
  return password;
}

// An HTTP field name (RFC 9110 `token`).
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;

// The header that a trusted proxy sets to the client's address, such as
// `CF-Connecting-IP`, from ARTIFACTS_CLIENT_ADDRESS_HEADER. Only the operator
// can name it: a header that is not named is never read, because any client
// can send one.
export function resolveClientAddressHeader(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const header = env.ARTIFACTS_CLIENT_ADDRESS_HEADER;
  if (header === undefined) {
    return undefined;
  }
  if (header.trim() === '') {
    throw new Error(
      'ARTIFACTS_CLIENT_ADDRESS_HEADER must not be blank; unset it to use the connection address',
    );
  }
  if (!HEADER_NAME.test(header)) {
    throw new Error(
      `ARTIFACTS_CLIENT_ADDRESS_HEADER must be an HTTP header name, got ${JSON.stringify(header)}`,
    );
  }
  return header;
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

// Session tokens are 256 random bits, so a plain keyed hash is enough to
// keep a copy of the database from holding usable tokens. Keying it with the
// password means a new password ends every existing session.
function tokenHash(token: string, passwordHash: Buffer): string {
  return createHmac('sha256', passwordHash).update(token).digest('hex');
}

// API keys are 256 random bits, so an unkeyed hash is enough to keep a copy
// of the database from holding usable keys. Unlike session tokens, the hash
// is not keyed by the password: a new password leaves agents connected, and
// the owner revokes keys on the key page, one by one or all at once.
function apiKeyHash(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

function secondsFrom(from: Date, until: Date): number {
  return Math.max(1, Math.ceil((until.getTime() - from.getTime()) / 1000));
}

// When a full count admits another attempt: once its earliest attempt leaves
// the window. Undefined when the count is not full.
function reopensAt({ count, oldest }: LoginAttemptCount, limit: number): Date | undefined {
  return count < limit || oldest === null
    ? undefined
    : new Date(new Date(oldest).getTime() + LOGIN_ATTEMPT_WINDOW_SECONDS * 1000);
}

// The single owner's password login, database sessions, and API keys. It
// knows nothing about HTTP: auth/routes.tsx maps it onto cookies, forms, and
// the Authorization header.
export function createOwnerAuth({
  clientAddressHeader,
  now = () => new Date(),
  password,
  store,
}: OwnerAuthOptions): OwnerAuth {
  const passwordHash = sha256(password);

  async function logIn(candidate: string, clientAddress: string): Promise<LoginResult> {
    const at = now();
    const since = new Date(at.getTime() - LOGIN_ATTEMPT_WINDOW_SECONDS * 1000).toISOString();
    const reserved = await store.reserveLoginAttempt(
      { at: at.toISOString(), clientAddress },
      since,
      { perClient: LOGIN_ATTEMPT_LIMIT, total: LOGIN_ATTEMPT_TOTAL_LIMIT },
    );
    if (!reserved) {
      // When both counts are full, the attempt waits for the later one.
      const counts = await store.countLoginAttemptsAfter(since, clientAddress);
      const reopenTimes = [
        reopensAt(counts.client, LOGIN_ATTEMPT_LIMIT),
        reopensAt(counts.total, LOGIN_ATTEMPT_TOTAL_LIMIT),
      ].filter((time) => time !== undefined);
      const reopens = new Date(Math.max(at.getTime(), ...reopenTimes.map((t) => t.getTime())));
      return { ok: false, reason: 'rate-limited', retryAfterSeconds: secondsFrom(at, reopens) };
    }
    // Comparing fixed-length digests keeps the comparison constant-time
    // whatever the candidate's length.
    if (!timingSafeEqual(sha256(candidate), passwordHash)) {
      return { ok: false, reason: 'incorrect-password' };
    }
    // Only the address that proved it knows the password is forgiven.
    await store.clearLoginAttempts(clientAddress);
    const token = randomBytes(32).toString('base64url');
    await store.createSession({
      createdAt: at.toISOString(),
      expiresAt: new Date(at.getTime() + SESSION_LIFETIME_SECONDS * 1000).toISOString(),
      tokenHash: tokenHash(token, passwordHash),
    });
    return { ok: true, token };
  }

  async function hasSession(token: string | undefined): Promise<boolean> {
    if (token === undefined || token === '') {
      return false;
    }
    const expiresAt = await store.findSessionExpiry(tokenHash(token, passwordHash));
    return expiresAt !== null && new Date(expiresAt) > now();
  }

  async function logOut(token: string | undefined): Promise<void> {
    if (token !== undefined && token !== '') {
      await store.removeSession(tokenHash(token, passwordHash));
    }
  }

  async function createApiKey(name: string): Promise<CreatedApiKey> {
    const id = randomBytes(12).toString('base64url');
    const key = `${API_KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
    await store.createApiKey({
      createdAt: now().toISOString(),
      id,
      keyHash: apiKeyHash(key),
      name,
    });
    return { id, key };
  }

  async function hasApiKey(key: string | undefined): Promise<boolean> {
    if (key === undefined || key === '') {
      return false;
    }
    const found = await store.findApiKeyByHash(apiKeyHash(key));
    if (found === null) {
      return false;
    }
    const at = now();
    const recordedBefore = new Date(at.getTime() - API_KEY_USE_RESOLUTION_SECONDS * 1000);
    if (found.lastUsedAt === null || new Date(found.lastUsedAt) <= recordedBefore) {
      await store.recordApiKeyUse(found.id, at.toISOString());
    }
    return true;
  }

  return {
    artifactUrls: createArtifactUrlSigner({ keys: store, now }),
    clientAddressHeader,
    createApiKey,
    hasApiKey,
    hasSession,
    listApiKeys: () => store.listApiKeys(),
    logIn,
    logOut,
    revokeAllApiKeys: () => store.removeAllApiKeys(),
    revokeApiKey: (id) => store.removeApiKey(id),
  };
}
