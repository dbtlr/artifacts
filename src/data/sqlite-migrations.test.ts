import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { RunnableMigration } from 'umzug';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';

import { SqliteArtifactMetadataStore } from './sqlite-artifact-metadata-store.js';
import { runSqliteMigrations, SqliteMigrationStorage } from './sqlite-migrations.js';

let directory: string;
let databasePath: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'artifacts-migrations-'));
  databasePath = join(directory, 'artifacts.db');
});

afterEach(() => {
  rmSync(directory, { force: true, recursive: true });
});

function tableNames(database: DatabaseSync): string[] {
  return database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => String(row.name));
}

describe('SQLite migrations', () => {
  it('creates the schema and records the initial migration on a fresh database', async () => {
    await SqliteArtifactMetadataStore.open(databasePath);
    const database = new DatabaseSync(databasePath);

    expect(tableNames(database)).toContain('artifacts');
    expect(database.prepare('SELECT name FROM artifact_migrations').get()).toEqual({
      name: '0001-initial-artifacts-schema',
    });
    database.close();
  });

  it('baselines a legacy database without changing its existing rows', async () => {
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE artifacts (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        project TEXT NOT NULL,
        description TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('html','md','txt')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO artifacts VALUES (
        'legacy', 'Legacy', 'artifacts', 'Preserved', 'txt',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );
    `);
    legacy.close();

    const store = await SqliteArtifactMetadataStore.open(databasePath);

    expect(store.find('legacy')).toMatchObject({ id: 'legacy', title: 'Legacy', type: 'txt' });
    const database = new DatabaseSync(databasePath);
    expect(database.prepare('SELECT COUNT(*) AS count FROM artifact_migrations').get()).toEqual({
      count: 1,
    });
    database.close();
  });

  it('is idempotent when the store is opened repeatedly', async () => {
    await SqliteArtifactMetadataStore.open(databasePath);
    await SqliteArtifactMetadataStore.open(databasePath);
    const database = new DatabaseSync(databasePath);

    expect(database.prepare('SELECT COUNT(*) AS count FROM artifact_migrations').get()).toEqual({
      count: 1,
    });
    database.close();
  });

  it('rolls back migration effects when a migration fails before history is recorded', async () => {
    const database = new DatabaseSync(databasePath);
    const failingMigration: RunnableMigration<DatabaseSync> = {
      name: 'broken-migration',
      up: async ({ context }) => {
        context.exec('CREATE TABLE must_not_survive (id TEXT)');
        throw new Error('injected migration failure');
      },
    };

    await expect(runSqliteMigrations(database, [failingMigration])).rejects.toThrow(
      'injected migration failure',
    );
    expect(tableNames(database)).not.toContain('must_not_survive');
    expect(database.prepare('SELECT COUNT(*) AS count FROM artifact_migrations').get()).toEqual({
      count: 0,
    });
    database.close();

    await expect(SqliteArtifactMetadataStore.open(databasePath)).resolves.toBeDefined();
  });

  it('preserves a migration-body error when its transaction is already gone', async () => {
    const database = new DatabaseSync(databasePath);
    const failingMigration: RunnableMigration<DatabaseSync> = {
      name: 'self-rolled-back-migration',
      up: async ({ context }) => {
        context.exec('ROLLBACK');
        throw new Error('primary migration failure');
      },
    };

    await expect(runSqliteMigrations(database, [failingMigration])).rejects.toThrow(
      'primary migration failure',
    );
    database.close();
  });

  it('preserves the history-write error when no transaction is available to roll back', async () => {
    const database = new DatabaseSync(databasePath);
    const storage = new SqliteMigrationStorage(database);
    database
      .prepare('INSERT INTO artifact_migrations (name, executed_at) VALUES (?, ?)')
      .run('duplicate', new Date().toISOString());

    await expect(storage.logMigration({ context: database, name: 'duplicate' })).rejects.toThrow(
      'UNIQUE constraint failed',
    );
    database.close();
  });

  it('waits for a concurrent startup writer instead of failing immediately', async () => {
    const lockScript = `
      const { DatabaseSync } = require('node:sqlite');
      const database = new DatabaseSync(process.argv[1]);
      database.exec('CREATE TABLE lock_fixture (id TEXT); BEGIN IMMEDIATE');
      process.stdout.write('locked');
      setTimeout(() => { database.exec('COMMIT'); database.close(); }, 100);
    `;
    const lockProcess = spawn(process.execPath, ['-e', lockScript, databasePath], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const exit = once(lockProcess, 'exit');
    await once(lockProcess.stdout, 'data');

    await expect(SqliteArtifactMetadataStore.open(databasePath)).resolves.toBeDefined();
    await exit;
  });
});
