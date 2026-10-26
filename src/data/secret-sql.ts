import type {
  SecretAdmission,
  SecretState,
  StoredClaim,
  StoredSecret,
  StoredUploadSlot,
} from '../secrets/types.js';
import type { SqlStatement } from './artifact-metadata-sql.js';

// The one-time secret statements that every SQLite-dialect adapter runs, so
// the node:sqlite and D1 adapters differ only in how they execute them. Each
// check-and-write is one statement, which SQLite runs atomically.

// Whether fewer than the limit of unread, unexpired secrets and upload slots
// exist. A used slot counts even past its expiry, until its upload or a sweep
// removes it: its upload's secret is stored only while the slot exists, so the
// place is never free while the secret can still arrive. Binds `now`, `now`,
// `limit`.
const ADMITTED = `(SELECT COUNT(*) FROM secrets WHERE read_at IS NULL AND expires_at > ?)
  + (SELECT COUNT(*) FROM secret_upload_slots WHERE expires_at > ? OR used_at IS NOT NULL) < ?`;

function admissionValues({ limit, now }: SecretAdmission): (number | string)[] {
  return [now, now, limit];
}

export function insertUploadSlot(slot: StoredUploadSlot, admission: SecretAdmission): SqlStatement {
  return {
    sql: `INSERT INTO secret_upload_slots (token_hash, label, filename, ttl_seconds, expires_at)
     SELECT ?, ?, ?, ?, ? WHERE ${ADMITTED}`,
    values: [
      slot.tokenHash,
      slot.label,
      slot.filename,
      slot.ttlSeconds,
      slot.expiresAt,
      ...admissionValues(admission),
    ],
  };
}

// Marks the slot used rather than deleting it, so it keeps its place under
// the limit while its upload is encrypted and stored.
export function takeUploadSlot(tokenHash: string, now: string): SqlStatement {
  return {
    sql: `UPDATE secret_upload_slots SET used_at = ?
     WHERE token_hash = ? AND used_at IS NULL AND expires_at > ? RETURNING *`,
    values: [now, tokenHash, now],
  };
}

export function deleteUploadSlot(tokenHash: string): SqlStatement {
  return { sql: 'DELETE FROM secret_upload_slots WHERE token_hash = ?', values: [tokenHash] };
}

const SECRET_INSERT = `INSERT INTO secrets
     (id, label, filename, ciphertext, nonce, created_at, expires_at)
     SELECT ?, ?, ?, ?, ?, ?, ?`;

function secretValues(secret: StoredSecret): (string | null)[] {
  return [
    secret.id,
    secret.label,
    secret.filename,
    secret.ciphertext,
    secret.nonce,
    secret.createdAt,
    secret.expiresAt,
  ];
}

export function insertSecret(secret: StoredSecret, admission: SecretAdmission): SqlStatement {
  return {
    sql: `${SECRET_INSERT} WHERE ${ADMITTED}`,
    values: [...secretValues(secret), ...admissionValues(admission)],
  };
}

// Inserts an upload's secret only while its used slot exists, so a sweep that
// already removed the slot, and freed its place, leaves the upload nothing to
// store.
export function insertUploadedSecret(secret: StoredSecret, tokenHash: string): SqlStatement {
  return {
    sql: `${SECRET_INSERT} WHERE EXISTS (SELECT 1 FROM secret_upload_slots
     WHERE token_hash = ? AND used_at IS NOT NULL)`,
    values: [...secretValues(secret), tokenHash],
  };
}

// A pending secret is unread, unexpired, and still holds its ciphertext: a
// sweep on a clock just ahead of `now` may have dropped it already.
const PENDING = 'read_at IS NULL AND ciphertext IS NOT NULL AND expires_at > ?';

export function findPendingSecret(id: string, now: string): SqlStatement {
  return { sql: `SELECT * FROM secrets WHERE id = ? AND ${PENDING}`, values: [id, now] };
}

export function consumeSecret(id: string, now: string): SqlStatement {
  return {
    sql: `UPDATE secrets SET ciphertext = NULL, read_at = ? WHERE id = ? AND ${PENDING}`,
    values: [now, id, now],
  };
}

export function findSecretState(id: string): SqlStatement {
  return { sql: 'SELECT expires_at, read_at FROM secrets WHERE id = ?', values: [id] };
}

// Inserts the claim when fewer than `admission.limit` unexpired claims on
// its secret exist.
export function insertClaim(claim: StoredClaim, { limit, now }: SecretAdmission): SqlStatement {
  return {
    sql: `INSERT INTO secret_claims (token_hash, secret_id, wrapped_key, nonce, expires_at)
     SELECT ?, ?, ?, ?, ?
     WHERE (SELECT COUNT(*) FROM secret_claims WHERE secret_id = ? AND expires_at > ?) < ?`,
    values: [
      claim.tokenHash,
      claim.secretId,
      claim.wrappedKey,
      claim.nonce,
      claim.expiresAt,
      claim.secretId,
      now,
      limit,
    ],
  };
}

export function takeClaim(tokenHash: string, now: string): SqlStatement {
  return {
    sql: 'DELETE FROM secret_claims WHERE token_hash = ? AND expires_at > ? RETURNING *',
    values: [tokenHash, now],
  };
}

// The statements are independent and may run in any order. Each stands
// alone, so a sweep cut short leaves nothing inconsistent and the next sweep
// finishes it.
export function sweepSecrets(now: string, tombstonesBefore: string): SqlStatement[] {
  return [
    { sql: 'DELETE FROM secret_upload_slots WHERE expires_at <= ?', values: [now] },
    { sql: 'DELETE FROM secret_claims WHERE expires_at <= ?', values: [now] },
    {
      sql: 'UPDATE secrets SET ciphertext = NULL WHERE expires_at <= ? AND ciphertext IS NOT NULL',
      values: [now],
    },
    {
      sql: 'DELETE FROM secrets WHERE COALESCE(read_at, expires_at) <= ?',
      values: [tombstonesBefore],
    },
  ];
}

function text(record: Record<string, unknown>, column: string): string {
  const value = record[column];
  if (typeof value !== 'string') {
    throw new TypeError(`Corrupt secret row: ${column} is not text`);
  }
  return value;
}

function textOrNull(record: Record<string, unknown>, column: string): string | null {
  return record[column] === null ? null : text(record, column);
}

// Maps a pending `secrets` row, which still holds its ciphertext.
export function secretFromRow(record: Record<string, unknown>): StoredSecret {
  return {
    ciphertext: text(record, 'ciphertext'),
    createdAt: text(record, 'created_at'),
    expiresAt: text(record, 'expires_at'),
    filename: textOrNull(record, 'filename'),
    id: text(record, 'id'),
    label: text(record, 'label'),
    nonce: text(record, 'nonce'),
  };
}

export function secretStateFromRow(record: Record<string, unknown>): SecretState {
  return { expiresAt: text(record, 'expires_at'), readAt: textOrNull(record, 'read_at') };
}

export function uploadSlotFromRow(record: Record<string, unknown>): StoredUploadSlot {
  const ttlSeconds = Number(record.ttl_seconds);
  if (!Number.isSafeInteger(ttlSeconds)) {
    throw new TypeError('Corrupt secret upload slot row: ttl_seconds is not an integer');
  }
  return {
    expiresAt: text(record, 'expires_at'),
    filename: textOrNull(record, 'filename'),
    label: text(record, 'label'),
    tokenHash: text(record, 'token_hash'),
    ttlSeconds,
  };
}

export function claimFromRow(record: Record<string, unknown>): StoredClaim {
  return {
    expiresAt: text(record, 'expires_at'),
    nonce: text(record, 'nonce'),
    secretId: text(record, 'secret_id'),
    tokenHash: text(record, 'token_hash'),
    wrappedKey: text(record, 'wrapped_key'),
  };
}
