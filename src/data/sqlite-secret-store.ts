import { DatabaseSync } from 'node:sqlite';

import type {
  SecretAdmission,
  SecretState,
  SecretStore,
  StoredClaim,
  StoredSecret,
  StoredUploadSlot,
} from '../secrets/types.js';
import type { SqlStatement } from './artifact-metadata-sql.js';
import {
  claimFromRow,
  consumeSecret,
  deleteUploadSlot,
  findPendingSecret,
  findSecretState,
  insertClaim,
  insertSecret,
  insertUploadedSecret,
  insertUploadSlot,
  secretFromRow,
  secretStateFromRow,
  sweepSecrets,
  takeClaim,
  takeUploadSlot,
  uploadSlotFromRow,
} from './secret-sql.js';
import { runSqliteMigrations } from './sqlite-migrations.js';

const SQLITE_BUSY_TIMEOUT_MS = 1_000;

// One-time secrets in the same database file as the artifact metadata, on
// their own connection like SqliteOwnerAuthStore.
export class SqliteSecretStore implements SecretStore {
  private readonly database: DatabaseSync;

  private constructor(database: DatabaseSync) {
    this.database = database;
  }

  static async open(databasePath: string): Promise<SqliteSecretStore> {
    const database = new DatabaseSync(databasePath, { timeout: SQLITE_BUSY_TIMEOUT_MS });
    try {
      await runSqliteMigrations(database);
      return new SqliteSecretStore(database);
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

  async createUploadSlot(slot: StoredUploadSlot, admission: SecretAdmission): Promise<boolean> {
    return this.run(insertUploadSlot(slot, admission)) > 0;
  }

  async takeUploadSlot(tokenHash: string, now: string): Promise<StoredUploadSlot | null> {
    const record = this.get(takeUploadSlot(tokenHash, now));
    return record === undefined ? null : uploadSlotFromRow(record);
  }

  async removeUploadSlot(tokenHash: string): Promise<void> {
    this.run(deleteUploadSlot(tokenHash));
  }

  async createSecret(secret: StoredSecret, admission: SecretAdmission): Promise<boolean> {
    return this.run(insertSecret(secret, admission)) > 0;
  }

  async createUploadedSecret(secret: StoredSecret, tokenHash: string): Promise<boolean> {
    return this.run(insertUploadedSecret(secret, tokenHash)) > 0;
  }

  async findPendingSecret(id: string, now: string): Promise<StoredSecret | null> {
    const record = this.get(findPendingSecret(id, now));
    return record === undefined ? null : secretFromRow(record);
  }

  async consumeSecret(id: string, now: string): Promise<boolean> {
    return this.run(consumeSecret(id, now)) > 0;
  }

  async findSecretState(id: string): Promise<SecretState | null> {
    const record = this.get(findSecretState(id));
    return record === undefined ? null : secretStateFromRow(record);
  }

  async createClaim(claim: StoredClaim, admission: SecretAdmission): Promise<boolean> {
    return this.run(insertClaim(claim, admission)) > 0;
  }

  async takeClaim(tokenHash: string, now: string): Promise<StoredClaim | null> {
    const record = this.get(takeClaim(tokenHash, now));
    return record === undefined ? null : claimFromRow(record);
  }

  async sweep(now: string, tombstonesBefore: string): Promise<void> {
    for (const statement of sweepSecrets(now, tombstonesBefore)) {
      this.run(statement);
    }
  }
}
