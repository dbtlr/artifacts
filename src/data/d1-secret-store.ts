import type {
  SecretAdmission,
  SecretState,
  SecretStore,
  StoredClaim,
  StoredSecret,
  StoredUploadSlot,
} from '../secrets/types.js';
import type { SqlStatement } from './artifact-metadata-sql.js';
import type { D1DatabaseBinding, D1PreparedStatementBinding } from './d1-database.js';
import {
  claimFromRow,
  consumeSecret,
  deleteUploadSlot,
  findPendingSecret,
  findSecretState,
  insertClaim,
  insertSecret,
  insertUploadSlot,
  secretFromRow,
  secretStateFromRow,
  sweepSecrets,
  takeClaim,
  takeUploadSlot,
  uploadSlotFromRow,
} from './secret-sql.js';

// One-time secrets in D1, running the same statements as the node:sqlite
// adapter. A D1 call that fails after its write committed loses at worst a
// slot, a claim, or a read: each fails closed. A create or upload that
// commits and then fails leaves a secret whose key no one received: it cannot
// be decrypted, and it holds a place under the limit until it expires.
export class D1SecretStore implements SecretStore {
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

  async createUploadSlot(slot: StoredUploadSlot, admission: SecretAdmission): Promise<boolean> {
    return (await this.run(insertUploadSlot(slot, admission))) > 0;
  }

  async takeUploadSlot(tokenHash: string, now: string): Promise<StoredUploadSlot | null> {
    const record = await this.statement(takeUploadSlot(tokenHash, now)).first();
    return record === null ? null : uploadSlotFromRow(record);
  }

  async removeUploadSlot(tokenHash: string): Promise<void> {
    await this.run(deleteUploadSlot(tokenHash));
  }

  async createSecret(secret: StoredSecret, admission?: SecretAdmission): Promise<boolean> {
    return (await this.run(insertSecret(secret, admission))) > 0;
  }

  async findPendingSecret(id: string, now: string): Promise<StoredSecret | null> {
    const record = await this.statement(findPendingSecret(id, now)).first();
    return record === null ? null : secretFromRow(record);
  }

  async consumeSecret(id: string, now: string): Promise<boolean> {
    return (await this.run(consumeSecret(id, now))) > 0;
  }

  async findSecretState(id: string): Promise<SecretState | null> {
    const record = await this.statement(findSecretState(id)).first();
    return record === null ? null : secretStateFromRow(record);
  }

  async createClaim(claim: StoredClaim, admission: SecretAdmission): Promise<boolean> {
    return (await this.run(insertClaim(claim, admission))) > 0;
  }

  async takeClaim(tokenHash: string, now: string): Promise<StoredClaim | null> {
    const record = await this.statement(takeClaim(tokenHash, now)).first();
    return record === null ? null : claimFromRow(record);
  }

  async sweep(now: string, tombstonesBefore: string): Promise<void> {
    await Promise.all(sweepSecrets(now, tombstonesBefore).map((statement) => this.run(statement)));
  }
}
