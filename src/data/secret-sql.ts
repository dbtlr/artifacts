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

// Whether fewer than the limit of unread, unexpired secrets and unused,
// unexpired upload slots exist. Binds `now`, `now`, `limit`.
const ADMITTED = `(SELECT COUNT(*) FROM secrets WHERE read_at IS NULL AND expires_at > ?)
  + (SELECT COUNT(*) FROM secret_upload_slots WHERE expires_at > ?) < ?`;

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

export function takeUploadSlot(tokenHash: string, now: string): SqlStatement {
  return {
    sql: 'DELETE FROM secret_upload_slots WHERE token_hash = ? AND expires_at > ? RETURNING *',
    values: [tokenHash, now],
  };
}

export function insertSecret(secret: StoredSecret, admission?: SecretAdmission): SqlStatement {
  const values = [
    secret.id,
    secret.label,
    secret.filename,
    secret.ciphertext,
    secret.nonce,
    secret.createdAt,
    secret.expiresAt,
  ];
  const columns = 'id, label, filename, ciphertext, nonce, created_at, expires_at';
  return admission === undefined
    ? { sql: `INSERT INTO secrets (${columns}) VALUES (?, ?, ?, ?, ?, ?, ?)`, values }
    : {
        sql: `INSERT INTO secrets (${columns}) SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${ADMITTED}`,
        values: [...values, ...admissionValues(admission)],
      };
}

export function findPendingSecret(id: string, now: string): SqlStatement {
  return {
    sql: 'SELECT * FROM secrets WHERE id = ? AND read_at IS NULL AND expires_at > ?',
    values: [id, now],
  };
}

export function consumeSecret(id: string, now: string): SqlStatement {
  return {
    sql: `UPDATE secrets SET ciphertext = NULL, read_at = ?
     WHERE id = ? AND read_at IS NULL AND expires_at > ?`,
    values: [now, id, now],
  };
}

export function findSecretState(id: string): SqlStatement {
  return { sql: 'SELECT expires_at, read_at FROM secrets WHERE id = ?', values: [id] };
}

export function insertClaim(claim: StoredClaim): SqlStatement {
  return {
    sql: `INSERT INTO secret_claims (token_hash, secret_id, wrapped_key, nonce, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
    values: [claim.tokenHash, claim.secretId, claim.wrappedKey, claim.nonce, claim.expiresAt],
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
