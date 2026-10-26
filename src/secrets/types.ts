// One-time secrets (ADR-0008). Times are ISO 8601 UTC strings, which sort as
// text. Binary values in the store are base64url text, so every adapter binds
// and reads plain strings.

// A secret as stored: only its ciphertext, never its contents or its key.
// `ciphertext` is AES-256-GCM output under a key Muninn does not keep, with
// the secret id as additional authenticated data.
export type StoredSecret = {
  ciphertext: string;
  createdAt: string;
  expiresAt: string;
  filename: string | null;
  id: string;
  label: string;
  nonce: string;
};

// A single-use upload URL's slot. It holds what the secret will be called and
// how long it will live, never contents. The token is kept only as a hash.
export type StoredUploadSlot = {
  expiresAt: string;
  filename: string | null;
  label: string;
  tokenHash: string;
  ttlSeconds: number;
};

// A single-use download URL's claim: the secret's data key, encrypted under a
// key derived from the claim token, which is kept only as a hash.
export type StoredClaim = {
  expiresAt: string;
  nonce: string;
  secretId: string;
  tokenHash: string;
  wrappedKey: string;
};

// What any secret row, read or not, still says about itself.
export type SecretState = { expiresAt: string; readAt: string | null };

// The cap on unread, unexpired secrets and unused, unexpired upload slots
// together, counted at `now`.
export type SecretAdmission = { limit: number; now: string };

// Persistence for one-time secrets. Async for the same reason as the artifact
// ports (see artifacts/types.ts). Every method that admits, takes, or consumes
// does its check and its write in one statement, so concurrent calls, from
// this process or another, cannot both succeed.
export type SecretStore = {
  // Stores the slot when fewer than `admission.limit` secrets and slots are
  // live. Resolves whether it was stored.
  createUploadSlot: (slot: StoredUploadSlot, admission: SecretAdmission) => Promise<boolean>;
  // Removes and resolves the slot with this hash when it is unexpired at
  // `now`, or resolves null. Only one caller ever gets a slot.
  takeUploadSlot: (tokenHash: string, now: string) => Promise<StoredUploadSlot | null>;
  // Stores the secret, and with `admission` only when fewer than its limit of
  // secrets and slots are live. Resolves whether it was stored. Rejects when
  // the id is taken.
  createSecret: (secret: StoredSecret, admission?: SecretAdmission) => Promise<boolean>;
  // The secret when it is unread and unexpired at `now`, or null.
  findPendingSecret: (id: string, now: string) => Promise<StoredSecret | null>;
  // Marks the secret read at `now` and drops its ciphertext, when it is unread
  // and unexpired. Resolves whether this call consumed it.
  consumeSecret: (id: string, now: string) => Promise<boolean>;
  // The secret's state, or null when no row has this id.
  findSecretState: (id: string) => Promise<SecretState | null>;
  createClaim: (claim: StoredClaim) => Promise<void>;
  // Removes and resolves the claim with this hash when it is unexpired at
  // `now`, or resolves null. Only one caller ever gets a claim.
  takeClaim: (tokenHash: string, now: string) => Promise<StoredClaim | null>;
  // Removes slots and claims expired at `now`, drops the ciphertext of
  // secrets expired at `now`, and removes secrets that were read or expired
  // at or before `tombstonesBefore`.
  sweep: (now: string, tombstonesBefore: string) => Promise<void>;
};

export type SecretUploadInput = { filename?: string; label: string; ttlSeconds?: number };

export type CreateSecretInput = SecretUploadInput & { content: Uint8Array };

// The upload token is not a secret: it creates one, and works once.
export type CreatedUpload = { expiresAt: string; uploadToken: string };

// The key exists only in this value; Muninn keeps no copy.
export type CreatedSecret = { expiresAt: string; id: string; key: string };

export type CreatedClaim = { claimToken: string; expiresAt: string };

export type SecretSummary = { expiresAt: string; filename: string | null; label: string };

export type RevealedSecret = { content: Uint8Array; filename: string | null; label: string };

export type SecretStatus = 'expired' | 'pending' | 'read' | 'unknown';

// One-time secrets, knowing nothing about HTTP or MCP. Invalid input rejects
// with InvalidSecretInputError and a full store with SecretLimitError (see
// secrets/errors.ts). Every read that fails resolves null, whether the secret
// is unknown, read, expired, or the key is wrong, so callers cannot tell
// those apart.
export type SecretService = {
  // An upload slot that lives 15 minutes and creates one secret.
  createUpload: (input: SecretUploadInput) => Promise<CreatedUpload>;
  // Uses the slot to store `content` as a new secret, or resolves null when
  // the token is unknown, used, or expired.
  upload: (uploadToken: string, content: Uint8Array) => Promise<CreatedSecret | null>;
  // Stores a secret directly, for the owner.
  create: (input: CreateSecretInput) => Promise<CreatedSecret>;
  // What an unread, unexpired secret is called, without its key.
  find: (id: string) => Promise<SecretSummary | null>;
  // Decrypts the secret and burns it. A wrong key leaves it unread.
  reveal: (id: string, key: string) => Promise<RevealedSecret | null>;
  // Checks the key without burning the secret and returns a download token
  // that lives 5 minutes and works once.
  claim: (id: string, key: string) => Promise<CreatedClaim | null>;
  // Uses the claim to reveal its secret.
  download: (claimToken: string) => Promise<RevealedSecret | null>;
  status: (id: string) => Promise<SecretStatus>;
  // Removes expired rows. `now` defaults to the service's clock.
  sweep: (now?: Date) => Promise<void>;
};
