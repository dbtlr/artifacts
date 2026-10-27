import { DatabaseSync } from 'node:sqlite';

import type {
  ApiKeySummary,
  ApiKeyUse,
  LoginAttempt,
  LoginAttemptCounts,
  LoginAttemptLimits,
  OwnerAuthStore,
  StoredApiKey,
  StoredSession,
} from '../auth/types.js';
import type { SqlStatement } from './artifact-metadata-sql.js';
import {
  apiKeySummaryFromRow,
  apiKeyUseFromRow,
  countLoginAttemptsAfter,
  deleteAllApiKeys,
  deleteApiKey,
  deleteExpiredSessions,
  deleteLoginAttempts,
  deleteLoginAttemptsUpTo,
  deleteOldUrlSigningKeys,
  deleteSession,
  findApiKeyByHash,
  findSessionExpiry,
  findUrlSigningKey,
  insertApiKey,
  insertLoginAttempt,
  insertSession,
  insertUrlSigningKey,
  listApiKeys,
  loginAttemptCountsFromRow,
  sessionExpiryFromRow,
  updateApiKeyUse,
  urlSigningKeyFromRow,
} from './owner-auth-sql.js';
import { runSqliteMigrations } from './sqlite-migrations.js';

const SQLITE_BUSY_TIMEOUT_MS = 1_000;

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

  private run({ sql, values }: SqlStatement): number {
    return Number(this.database.prepare(sql).run(...values).changes);
  }

  private get({ sql, values }: SqlStatement): Record<string, unknown> | undefined {
    return this.database.prepare(sql).get(...values);
  }

  async reserveLoginAttempt(
    attempt: LoginAttempt,
    since: string,
    limits: LoginAttemptLimits,
  ): Promise<boolean> {
    this.run(deleteLoginAttemptsUpTo(since));
    return this.run(insertLoginAttempt(attempt, since, limits)) > 0;
  }

  async countLoginAttemptsAfter(since: string, clientAddress: string): Promise<LoginAttemptCounts> {
    return loginAttemptCountsFromRow(this.get(countLoginAttemptsAfter(since, clientAddress)));
  }

  async clearLoginAttempts(clientAddress: string): Promise<void> {
    this.run(deleteLoginAttempts(clientAddress));
  }

  async createSession(session: StoredSession): Promise<void> {
    this.run(deleteExpiredSessions(session.createdAt));
    this.run(insertSession(session));
  }

  async findSessionExpiry(tokenHash: string): Promise<string | null> {
    const record = this.get(findSessionExpiry(tokenHash));
    return record === undefined ? null : sessionExpiryFromRow(record);
  }

  async removeSession(tokenHash: string): Promise<void> {
    this.run(deleteSession(tokenHash));
  }

  async createApiKey(key: StoredApiKey): Promise<void> {
    this.run(insertApiKey(key));
  }

  async listApiKeys(): Promise<ApiKeySummary[]> {
    const { sql, values } = listApiKeys();
    return this.database
      .prepare(sql)
      .all(...values)
      .map(apiKeySummaryFromRow);
  }

  async findApiKeyByHash(keyHash: string): Promise<ApiKeyUse | null> {
    const record = this.get(findApiKeyByHash(keyHash));
    return record === undefined ? null : apiKeyUseFromRow(record);
  }

  async recordApiKeyUse(id: string, at: string): Promise<void> {
    this.run(updateApiKeyUse(id, at));
  }

  async removeApiKey(id: string): Promise<void> {
    this.run(deleteApiKey(id));
  }

  async removeAllApiKeys(): Promise<void> {
    this.run(deleteAllApiKeys());
  }

  async createUrlSigningKey(bucket: number, key: string): Promise<string> {
    this.run(deleteOldUrlSigningKeys(bucket));
    this.run(insertUrlSigningKey(bucket, key));
    const stored = await this.findUrlSigningKey(bucket);
    if (stored === null) {
      throw new Error(`The URL signing key for bucket ${String(bucket)} was not stored`);
    }
    return stored;
  }

  async findUrlSigningKey(bucket: number): Promise<string | null> {
    const record = this.get(findUrlSigningKey(bucket));
    return record === undefined ? null : urlSigningKeyFromRow(record);
  }
}
