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

// A cap counted at `now`: on unread, unexpired secrets and upload slots
// together, or on one secret's unexpired claims.
export type SecretAdmission = { limit: number; now: string };

// Persistence for one-time secrets. Async for the same reason as the artifact
// ports (see artifacts/types.ts). Every method that admits, takes, or consumes
// does its check and its write in one statement, so concurrent calls, from
// this process or another, cannot both succeed.
export type SecretStore = {
  // Stores the slot when fewer than `admission.limit` secrets and slots are
  // live. Resolves whether it was stored.
  createUploadSlot: (slot: StoredUploadSlot, admission: SecretAdmission) => Promise<boolean>;
  // Marks the slot with this hash used and resolves it when it is unused and
  // unexpired at `now`, or resolves null. Only one caller ever gets a slot. A
  // used slot still counts against the limit until it is removed.
  takeUploadSlot: (tokenHash: string, now: string) => Promise<StoredUploadSlot | null>;
  // Removes the slot with this hash, once its upload's secret is stored.
  removeUploadSlot: (tokenHash: string) => Promise<void>;
  // Stores the secret, and with `admission` only when fewer than its limit of
  // secrets and slots are live. Resolves whether it was stored. Rejects when
  // the id is taken. An upload passes no admission: its used slot keeps the
  // place until the upload removes it.
  createSecret: (secret: StoredSecret, admission?: SecretAdmission) => Promise<boolean>;
  // The secret when it is unread, unexpired at `now`, and still holds its
  // ciphertext, or null.
  findPendingSecret: (id: string, now: string) => Promise<StoredSecret | null>;
  // Marks the secret read at `now` and drops its ciphertext, when it is
  // pending as findPendingSecret means it. Resolves whether this call
  // consumed it.
  consumeSecret: (id: string, now: string) => Promise<boolean>;
  // The secret's state, or null when no row has this id.
  findSecretState: (id: string) => Promise<SecretState | null>;
  // Stores the claim when fewer than `admission.limit` claims on its secret
  // are unexpired. Resolves whether it was stored.
  createClaim: (claim: StoredClaim, admission: SecretAdmission) => Promise<boolean>;
  // Removes and resolves the claim with this hash when it is unexpired at
  // `now`, or resolves null. Only one caller ever gets a claim.
  takeClaim: (tokenHash: string, now: string) => Promise<StoredClaim | null>;
  // Removes slots, used or not, and claims expired at `now`, drops the
  // ciphertext of secrets expired at `now`, and removes secrets that were
  // read or expired at or before `tombstonesBefore`.
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
// is unknown, read, expired, or the key is wrong, so a read's caller cannot
// tell those apart. `status` distinguishes them by design: it is for MCP and
// the owner only and never backs a public page.
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
  // that lives 5 minutes and works once. Resolves null when the secret
  // already has 5 unexpired claims.
  claim: (id: string, key: string) => Promise<CreatedClaim | null>;
  // Uses the claim to reveal its secret.
  download: (claimToken: string) => Promise<RevealedSecret | null>;
  status: (id: string) => Promise<SecretStatus>;
  // Removes expired rows as of the service's clock.
  sweep: () => Promise<void>;
};
