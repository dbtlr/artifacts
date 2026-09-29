import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import type { OwnerAuthStore } from './types.js';

// A session lasts a fixed 7 days from login; using it does not extend it.
export const SESSION_LIFETIME_SECONDS = 7 * 24 * 60 * 60;
// At most this many login attempts, right or wrong, in any rolling window.
// The limit is global rather than per client: behind a proxy every client
// has the proxy's address. An attacker can therefore keep the owner locked
// out, which is the accepted cost of bounding guesses to about 1,000 a day.
export const LOGIN_ATTEMPT_LIMIT = 10;
export const LOGIN_ATTEMPT_WINDOW_SECONDS = 15 * 60;

export type LoginResult =
  | { ok: true; token: string }
  | { ok: false; reason: 'incorrect-password' }
  | { ok: false; reason: 'rate-limited'; retryAfterSeconds: number };

export type OwnerAuth = {
  hasSession: (token: string | undefined) => Promise<boolean>;
  logIn: (password: string) => Promise<LoginResult>;
  logOut: (token: string | undefined) => Promise<void>;
};

type OwnerAuthOptions = {
  now?: () => Date;
  password: string;
  store: OwnerAuthStore;
};

// Owner auth is on exactly when ARTIFACTS_OWNER_PASSWORD is set. A blank
// value is refused rather than read as "off", so a half-written secret
// cannot silently leave an instance open.
export function resolveOwnerPassword(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const password = env.ARTIFACTS_OWNER_PASSWORD;
  if (password !== undefined && password.trim() === '') {
    throw new Error('ARTIFACTS_OWNER_PASSWORD must not be blank; unset it to turn auth off');
  }
  return password;
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

function secondsFrom(from: Date, until: Date): number {
  return Math.max(1, Math.ceil((until.getTime() - from.getTime()) / 1000));
}

// The single owner's password login and database sessions. It knows nothing
// about HTTP: auth/routes.tsx maps it onto cookies and forms.
export function createOwnerAuth({
  now = () => new Date(),
  password,
  store,
}: OwnerAuthOptions): OwnerAuth {
  const passwordHash = sha256(password);

  async function logIn(candidate: string): Promise<LoginResult> {
    const at = now();
    const windowStart = new Date(at.getTime() - LOGIN_ATTEMPT_WINDOW_SECONDS * 1000);
    const reserved = await store.reserveLoginAttempt(
      at.toISOString(),
      windowStart.toISOString(),
      LOGIN_ATTEMPT_LIMIT,
    );
    if (!reserved) {
      const oldest = await store.oldestLoginAttemptAfter(windowStart.toISOString());
      const reopensAt =
        oldest === null
          ? at
          : new Date(new Date(oldest).getTime() + LOGIN_ATTEMPT_WINDOW_SECONDS * 1000);
      return { ok: false, reason: 'rate-limited', retryAfterSeconds: secondsFrom(at, reopensAt) };
    }
    // Comparing fixed-length digests keeps the comparison constant-time
    // whatever the candidate's length.
    if (!timingSafeEqual(sha256(candidate), passwordHash)) {
      return { ok: false, reason: 'incorrect-password' };
    }
    await store.clearLoginAttempts();
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

  return { hasSession, logIn, logOut };
}
