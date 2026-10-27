import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach } from 'vite-plus/test';

import { ownerAuthStoreContract } from './owner-auth-store-contract.test-support.js';
import { SqliteOwnerAuthStore } from './sqlite-owner-auth-store.js';

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'muninn-owner-auth-store-'));
});

afterEach(() => {
  rmSync(directory, { force: true, recursive: true });
});

ownerAuthStoreContract('sqlite', async () => {
  const databasePath = join(directory, 'muninn.db');
  const store = await SqliteOwnerAuthStore.open(databasePath);
  return {
    loginAttemptRows: async () => {
      const database = new DatabaseSync(databasePath, { readOnly: true });
      try {
        return database.prepare('SELECT * FROM login_attempts').all();
      } finally {
        database.close();
      }
    },
    store,
  };
});
