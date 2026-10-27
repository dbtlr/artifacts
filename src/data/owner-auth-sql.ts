import type {
  ApiKeySummary,
  ApiKeyUse,
  LoginAttempt,
  LoginAttemptCounts,
  LoginAttemptLimits,
  StoredApiKey,
  StoredSession,
} from '../auth/types.js';
import type { SqlStatement } from './artifact-metadata-sql.js';

// The owner auth statements that every SQLite-dialect adapter runs, so the
// node:sqlite and D1 adapters differ only in how they execute them. Each
// check-and-write is one statement, which SQLite runs atomically. The
// deletes that prune old rows stand alone: each removes only rows that no
// check counts any more, so it may run before or apart from its write.

export function deleteLoginAttemptsUpTo(since: string): SqlStatement {
  return { sql: 'DELETE FROM login_attempts WHERE attempted_at <= ?', values: [since] };
}

// Inserts the attempt when, after `since`, its address has fewer than
// `perClient` attempts and all addresses together fewer than `total`.
export function insertLoginAttempt(
  { at, clientAddress }: LoginAttempt,
  since: string,
  { perClient, total }: LoginAttemptLimits,
): SqlStatement {
  return {
    sql: `INSERT INTO login_attempts (attempted_at, client_address)
         SELECT ?, ?
         WHERE (SELECT COUNT(*) FROM login_attempts
                WHERE client_address = ? AND attempted_at > ?) < ?
           AND (SELECT COUNT(*) FROM login_attempts WHERE attempted_at > ?) < ?`,
    values: [at, clientAddress, clientAddress, since, perClient, since, total],
  };
}

export function countLoginAttemptsAfter(since: string, clientAddress: string): SqlStatement {
  return {
    sql: `SELECT COUNT(*) AS total_count,
                MIN(attempted_at) AS total_oldest,
                COUNT(CASE WHEN client_address = ? THEN 1 END) AS client_count,
                MIN(CASE WHEN client_address = ? THEN attempted_at END) AS client_oldest
         FROM login_attempts WHERE attempted_at > ?`,
    values: [clientAddress, clientAddress, since],
  };
}

export function deleteLoginAttempts(clientAddress: string): SqlStatement {
  return { sql: 'DELETE FROM login_attempts WHERE client_address = ?', values: [clientAddress] };
}

export function deleteExpiredSessions(now: string): SqlStatement {
  return { sql: 'DELETE FROM owner_sessions WHERE expires_at <= ?', values: [now] };
}

export function insertSession({ createdAt, expiresAt, tokenHash }: StoredSession): SqlStatement {
  return {
    sql: 'INSERT INTO owner_sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)',
    values: [tokenHash, createdAt, expiresAt],
  };
}

export function findSessionExpiry(tokenHash: string): SqlStatement {
  return { sql: 'SELECT expires_at FROM owner_sessions WHERE token_hash = ?', values: [tokenHash] };
}

export function deleteSession(tokenHash: string): SqlStatement {
  return { sql: 'DELETE FROM owner_sessions WHERE token_hash = ?', values: [tokenHash] };
}

export function insertApiKey({ createdAt, id, keyHash, name }: StoredApiKey): SqlStatement {
  return {
    sql: 'INSERT INTO api_keys (id, name, key_hash, created_at) VALUES (?, ?, ?, ?)',
    values: [id, name, keyHash, createdAt],
  };
}

// Oldest first. rowid breaks ties between keys made in the same
// millisecond, so the earlier insert lists first.
export function listApiKeys(): SqlStatement {
  return {
    sql: 'SELECT id, name, created_at, last_used_at FROM api_keys ORDER BY created_at, rowid',
    values: [],
  };
}

export function findApiKeyByHash(keyHash: string): SqlStatement {
  return { sql: 'SELECT id, last_used_at FROM api_keys WHERE key_hash = ?', values: [keyHash] };
}

export function updateApiKeyUse(id: string, at: string): SqlStatement {
  return { sql: 'UPDATE api_keys SET last_used_at = ? WHERE id = ?', values: [at, id] };
}

export function deleteApiKey(id: string): SqlStatement {
  return { sql: 'DELETE FROM api_keys WHERE id = ?', values: [id] };
}

export function deleteAllApiKeys(): SqlStatement {
  return { sql: 'DELETE FROM api_keys', values: [] };
}

// Removes every key older than the bucket before `bucket`.
export function deleteOldUrlSigningKeys(bucket: number): SqlStatement {
  return { sql: 'DELETE FROM url_signing_keys WHERE bucket < ?', values: [bucket - 1] };
}

// Inserts the key unless the bucket already has one, which it keeps.
export function insertUrlSigningKey(bucket: number, key: string): SqlStatement {
  return {
    sql: 'INSERT INTO url_signing_keys (bucket, signing_key) VALUES (?, ?) ON CONFLICT DO NOTHING',
    values: [bucket, key],
  };
}

export function findUrlSigningKey(bucket: number): SqlStatement {
  return {
    sql: 'SELECT signing_key FROM url_signing_keys WHERE bucket = ?',
    values: [bucket],
  };
}

function text(record: Record<string, unknown>, column: string): string {
  const value = record[column];
  if (typeof value !== 'string') {
    throw new TypeError(`Corrupt owner auth row: ${column} is not text`);
  }
  return value;
}

function textOrNull(record: Record<string, unknown>, column: string): string | null {
  return record[column] === null ? null : text(record, column);
}

// Maps the row of countLoginAttemptsAfter, which yields one row even when it
// counts none.
export function loginAttemptCountsFromRow(
  record: Record<string, unknown> | null | undefined,
): LoginAttemptCounts {
  if (record === null || record === undefined) {
    throw new TypeError('Counting login attempts yielded no row');
  }
  return {
    client: { count: Number(record.client_count), oldest: textOrNull(record, 'client_oldest') },
    total: { count: Number(record.total_count), oldest: textOrNull(record, 'total_oldest') },
  };
}

export function sessionExpiryFromRow(record: Record<string, unknown>): string {
  return text(record, 'expires_at');
}

export function apiKeySummaryFromRow(record: Record<string, unknown>): ApiKeySummary {
  return {
    createdAt: text(record, 'created_at'),
    id: text(record, 'id'),
    lastUsedAt: textOrNull(record, 'last_used_at'),
    name: text(record, 'name'),
  };
}

export function apiKeyUseFromRow(record: Record<string, unknown>): ApiKeyUse {
  return { id: text(record, 'id'), lastUsedAt: textOrNull(record, 'last_used_at') };
}

export function urlSigningKeyFromRow(record: Record<string, unknown>): string {
  return text(record, 'signing_key');
}
