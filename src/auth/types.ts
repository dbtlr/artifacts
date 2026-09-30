// Persistence for owner auth. Async for the same reason as the artifact
// ports (see artifacts/types.ts): an adapter over an async-only database
// fits behind it. Times are ISO 8601 UTC strings, which sort as text.
export type OwnerAuthStore = UrlSigningKeyStore & {
  // Records an attempt from `attempt.clientAddress` at `attempt.at` unless,
  // after `since`, that address already has `limits.perClient` attempts or
  // all addresses together have `limits.total`. Resolves whether it was
  // recorded. The check and the insert are one step, so parallel attempts
  // cannot all slip under a limit.
  reserveLoginAttempt: (
    attempt: LoginAttempt,
    since: string,
    limits: LoginAttemptLimits,
  ) => Promise<boolean>;
  // The attempts recorded after `since`: those from `clientAddress`, and all.
  countLoginAttemptsAfter: (since: string, clientAddress: string) => Promise<LoginAttemptCounts>;
  // Forgets every attempt from `clientAddress`.
  clearLoginAttempts: (clientAddress: string) => Promise<void>;
  // Stores a session and removes every session that expired by `createdAt`.
  createSession: (session: StoredSession) => Promise<void>;
  // The session's expiry, or null when no session has this hash.
  findSessionExpiry: (tokenHash: string) => Promise<string | null>;
  removeSession: (tokenHash: string) => Promise<void>;
  createApiKey: (key: StoredApiKey) => Promise<void>;
  // Every key, oldest first, without its hash.
  listApiKeys: () => Promise<ApiKeySummary[]>;
  // The key with this hash, or null when there is none.
  findApiKeyByHash: (keyHash: string) => Promise<ApiKeyUse | null>;
  // Sets the key's last use to `at`. An unknown id is not an error.
  recordApiKeyUse: (id: string, at: string) => Promise<void>;
  // Removing an unknown id is not an error.
  removeApiKey: (id: string) => Promise<void>;
  removeAllApiKeys: () => Promise<void>;
};

// `clientAddress` is empty when the request's address is unknown; all such
// attempts share one count.
export type LoginAttempt = { at: string; clientAddress: string };

export type LoginAttemptLimits = { perClient: number; total: number };

// How many attempts a count holds, and the time of the earliest, or null
// when it holds none.
export type LoginAttemptCount = { count: number; oldest: string | null };

export type LoginAttemptCounts = { client: LoginAttemptCount; total: LoginAttemptCount };

export type StoredSession = { createdAt: string; expiresAt: string; tokenHash: string };

export type StoredApiKey = { createdAt: string; id: string; keyHash: string; name: string };

// When a key last opened /mcp, or null when it never has.
export type ApiKeyUse = { id: string; lastUsedAt: string | null };

// What the key page shows about a key. The secret itself is never kept.
export type ApiKeySummary = Omit<StoredApiKey, 'keyHash'> & ApiKeyUse;

// The keys that sign artifact URLs, one per clock-hour bucket: the Unix time
// in seconds divided by 3600, rounded down. Keys are base64url text. Every
// process that shares the database shares the keys.
export type UrlSigningKeyStore = {
  // Stores `key` for `bucket` unless the bucket already has one, removes
  // every key older than the bucket before it, and resolves the key the
  // bucket holds. An existing key is never replaced, so processes that make
  // a bucket's key at once all get the first one stored.
  createUrlSigningKey: (bucket: number, key: string) => Promise<string>;
  // The bucket's key, or null when it has none.
  findUrlSigningKey: (bucket: number) => Promise<string | null>;
};
