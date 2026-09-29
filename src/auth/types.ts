// Persistence for owner auth. Async for the same reason as the artifact
// ports (see artifacts/types.ts): an adapter over an async-only database
// fits behind it. Times are ISO 8601 UTC strings, which sort as text.
export type OwnerAuthStore = {
  // Records an attempt at `at` unless `limit` attempts are already recorded
  // after `since`, and resolves whether it was recorded. The check and the
  // insert are one step, so parallel attempts cannot all slip under the limit.
  reserveLoginAttempt: (at: string, since: string, limit: number) => Promise<boolean>;
  // The earliest attempt recorded after `since`, or null when there is none.
  oldestLoginAttemptAfter: (since: string) => Promise<string | null>;
  clearLoginAttempts: () => Promise<void>;
  // Stores a session and removes every session that expired by `createdAt`.
  createSession: (session: StoredSession) => Promise<void>;
  // The session's expiry, or null when no session has this hash.
  findSessionExpiry: (tokenHash: string) => Promise<string | null>;
  removeSession: (tokenHash: string) => Promise<void>;
  createApiKey: (key: StoredApiKey) => Promise<void>;
  // Every key, oldest first, without its hash.
  listApiKeys: () => Promise<ApiKeySummary[]>;
  hasApiKeyHash: (keyHash: string) => Promise<boolean>;
  // Removing an unknown id is not an error.
  removeApiKey: (id: string) => Promise<void>;
};

export type StoredSession = { createdAt: string; expiresAt: string; tokenHash: string };

// What the key page shows about a key. The secret itself is never kept.
export type ApiKeySummary = { createdAt: string; id: string; name: string };

export type StoredApiKey = ApiKeySummary & { keyHash: string };
