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
import type { D1DatabaseBinding, D1PreparedStatementBinding } from './d1-database.js';
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

// Owner sessions, login attempts, API keys, and URL signing keys in D1,
// running the same statements as the node:sqlite adapter. A D1 call that
// fails after its write committed either fails closed or is harmless. A
// reserved attempt counts against the limit though its login never ran. A
// created session or API key is stored under a hash of a token no one
// received, so it opens nothing; the key shows on the key page until it is
// revoked. A removal, a cleared count, a recorded use, or a pruning delete
// has already done what it was asked. A URL signing key made for a bucket is
// what the next call reads back. Unlike in one node:sqlite process, another
// call can run between the signing-key insert and its read: a process whose
// clock runs two or more hours ahead can prune the key in that gap, and the
// call then throws.
export class D1OwnerAuthStore implements OwnerAuthStore {
  private readonly database: D1DatabaseBinding;

  constructor(database: D1DatabaseBinding) {
    this.database = database;
  }

  private statement({ sql, values }: SqlStatement): D1PreparedStatementBinding {
    return this.database.prepare(sql).bind(...values);
  }

  private async run(statement: SqlStatement): Promise<number> {
    const { meta } = await this.statement(statement).run();
    return meta.changes;
  }

  async reserveLoginAttempt(
    attempt: LoginAttempt,
    since: string,
    limits: LoginAttemptLimits,
  ): Promise<boolean> {
    await this.run(deleteLoginAttemptsUpTo(since));
    return (await this.run(insertLoginAttempt(attempt, since, limits))) > 0;
  }

  async countLoginAttemptsAfter(since: string, clientAddress: string): Promise<LoginAttemptCounts> {
    return loginAttemptCountsFromRow(
      await this.statement(countLoginAttemptsAfter(since, clientAddress)).first(),
    );
  }

  async clearLoginAttempts(clientAddress: string): Promise<void> {
    await this.run(deleteLoginAttempts(clientAddress));
  }

  async createSession(session: StoredSession): Promise<void> {
    await this.run(deleteExpiredSessions(session.createdAt));
    await this.run(insertSession(session));
  }

  async findSessionExpiry(tokenHash: string): Promise<string | null> {
    const record = await this.statement(findSessionExpiry(tokenHash)).first();
    return record === null ? null : sessionExpiryFromRow(record);
  }

  async removeSession(tokenHash: string): Promise<void> {
    await this.run(deleteSession(tokenHash));
  }

  async createApiKey(key: StoredApiKey): Promise<void> {
    await this.run(insertApiKey(key));
  }

  async listApiKeys(): Promise<ApiKeySummary[]> {
    const { results } = await this.statement(listApiKeys()).all();
    return results.map(apiKeySummaryFromRow);
  }

  async findApiKeyByHash(keyHash: string): Promise<ApiKeyUse | null> {
    const record = await this.statement(findApiKeyByHash(keyHash)).first();
    return record === null ? null : apiKeyUseFromRow(record);
  }

  async recordApiKeyUse(id: string, at: string): Promise<void> {
    await this.run(updateApiKeyUse(id, at));
  }

  async removeApiKey(id: string): Promise<void> {
    await this.run(deleteApiKey(id));
  }

  async removeAllApiKeys(): Promise<void> {
    await this.run(deleteAllApiKeys());
  }

  async createUrlSigningKey(bucket: number, key: string): Promise<string> {
    await this.run(deleteOldUrlSigningKeys(bucket));
    await this.run(insertUrlSigningKey(bucket, key));
    const stored = await this.findUrlSigningKey(bucket);
    if (stored === null) {
      throw new Error(`The URL signing key for bucket ${String(bucket)} was not stored`);
    }
    return stored;
  }

  async findUrlSigningKey(bucket: number): Promise<string | null> {
    const record = await this.statement(findUrlSigningKey(bucket)).first();
    return record === null ? null : urlSigningKeyFromRow(record);
  }
}
