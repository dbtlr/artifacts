import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach } from 'vite-plus/test';

import { secretStoreContract } from './secret-store-contract.test-support.js';
import { SqliteSecretStore } from './sqlite-secret-store.js';

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'muninn-secret-store-'));
});

afterEach(() => {
  rmSync(directory, { force: true, recursive: true });
});

secretStoreContract('sqlite', async () => {
  const databasePath = join(directory, 'muninn.db');
  const store = await SqliteSecretStore.open(databasePath);
  return {
    rows: async (table) => {
      const database = new DatabaseSync(databasePath, { readOnly: true });
      try {
        return database.prepare(`SELECT * FROM ${table}`).all();
      } finally {
        database.close();
      }
    },
    store,
  };
});
