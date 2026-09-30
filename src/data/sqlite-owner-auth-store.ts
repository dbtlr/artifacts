import { DatabaseSync } from 'node:sqlite';
import type { SQLOutputValue } from 'node:sqlite';

import type {
  ApiKeySummary,
  LoginAttempt,
  LoginAttemptCounts,
  LoginAttemptLimits,
  OwnerAuthStore,
  StoredApiKey,
  StoredSession,
} from '../auth/types.js';
import { runSqliteMigrations } from './sqlite-migrations.js';

const SQLITE_BUSY_TIMEOUT_MS = 1_000;

function textOrNull(value: SQLOutputValue | undefined): string | null {
  return value === null || value === undefined ? null : String(value);
}

// Owner sessions, login attempts, API keys, and URL signing keys, in the
// same database file as the artifact metadata. It opens its own connection;
// the migration runner's write lock makes opening both connections safe in
// either order.
export class SqliteOwnerAuthStore implements OwnerAuthStore {
  private readonly database: DatabaseSync;

  private constructor(database: DatabaseSync) {
    this.database = database;
  }

  static async open(databasePath: string): Promise<SqliteOwnerAuthStore> {
    const database = new DatabaseSync(databasePath, { timeout: SQLITE_BUSY_TIMEOUT_MS });
    try {
      await runSqliteMigrations(database);
      return new SqliteOwnerAuthStore(database);
    } catch (error) {
      database.close();
      throw error;
    }
  }

  async reserveLoginAttempt(
    { at, clientAddress }: LoginAttempt,
    since: string,
    { perClient, total }: LoginAttemptLimits,
  ): Promise<boolean> {
    this.database.prepare('DELETE FROM login_attempts WHERE attempted_at <= ?').run(since);
    const { changes } = this.database
      .prepare(
        `INSERT INTO login_attempts (attempted_at, client_address)
         SELECT ?, ?
         WHERE (SELECT COUNT(*) FROM login_attempts
                WHERE client_address = ? AND attempted_at > ?) < ?
           AND (SELECT COUNT(*) FROM login_attempts WHERE attempted_at > ?) < ?`,
      )
      .run(at, clientAddress, clientAddress, since, perClient, since, total);
    return changes > 0;
  }

  async countLoginAttemptsAfter(since: string, clientAddress: string): Promise<LoginAttemptCounts> {
    const record = this.database
      .prepare(
        `SELECT COUNT(*) AS total_count,
                MIN(attempted_at) AS total_oldest,
                COUNT(CASE WHEN client_address = ? THEN 1 END) AS client_count,
                MIN(CASE WHEN client_address = ? THEN attempted_at END) AS client_oldest
         FROM login_attempts WHERE attempted_at > ?`,
      )
      .get(clientAddress, clientAddress, since);
    return {
      client: { count: Number(record?.client_count), oldest: textOrNull(record?.client_oldest) },
      total: { count: Number(record?.total_count), oldest: textOrNull(record?.total_oldest) },
    };
  }

  async clearLoginAttempts(clientAddress: string): Promise<void> {
    this.database.prepare('DELETE FROM login_attempts WHERE client_address = ?').run(clientAddress);
  }

  async createSession({ createdAt, expiresAt, tokenHash }: StoredSession): Promise<void> {
    this.database.prepare('DELETE FROM owner_sessions WHERE expires_at <= ?').run(createdAt);
    this.database
      .prepare('INSERT INTO owner_sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)')
      .run(tokenHash, createdAt, expiresAt);
  }

  async findSessionExpiry(tokenHash: string): Promise<string | null> {
    const record = this.database
      .prepare('SELECT expires_at FROM owner_sessions WHERE token_hash = ?')
      .get(tokenHash);
    return record === undefined ? null : String(record.expires_at);
  }

  async removeSession(tokenHash: string): Promise<void> {
    this.database.prepare('DELETE FROM owner_sessions WHERE token_hash = ?').run(tokenHash);
  }

  async createApiKey({ createdAt, id, keyHash, name }: StoredApiKey): Promise<void> {
    this.database
      .prepare('INSERT INTO api_keys (id, name, key_hash, created_at) VALUES (?, ?, ?, ?)')
      .run(id, name, keyHash, createdAt);
  }

  async listApiKeys(): Promise<ApiKeySummary[]> {
    return this.database
      .prepare('SELECT id, name, created_at FROM api_keys ORDER BY created_at, rowid')
      .all()
      .map((row) => ({
        createdAt: String(row.created_at),
        id: String(row.id),
        name: String(row.name),
      }));
  }

  async hasApiKeyHash(keyHash: string): Promise<boolean> {
    return (
      this.database.prepare('SELECT 1 FROM api_keys WHERE key_hash = ?').get(keyHash) !== undefined
    );
  }

  async removeApiKey(id: string): Promise<void> {
    this.database.prepare('DELETE FROM api_keys WHERE id = ?').run(id);
  }

  async createUrlSigningKey(bucket: number, key: string): Promise<string> {
    this.database.prepare('DELETE FROM url_signing_keys WHERE bucket < ?').run(bucket - 1);
    this.database
      .prepare(
        'INSERT INTO url_signing_keys (bucket, signing_key) VALUES (?, ?) ON CONFLICT DO NOTHING',
      )
      .run(bucket, key);
    const stored = await this.findUrlSigningKey(bucket);
    if (stored === null) {
      throw new Error(`The URL signing key for bucket ${String(bucket)} was not stored`);
    }
    return stored;
  }

  async findUrlSigningKey(bucket: number): Promise<string | null> {
    const record = this.database
      .prepare('SELECT signing_key FROM url_signing_keys WHERE bucket = ?')
      .get(bucket);
    return record === undefined ? null : String(record.signing_key);
  }
}
