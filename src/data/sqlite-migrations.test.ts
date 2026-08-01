import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { RunnableMigration } from 'umzug';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';

import { SqliteArtifactMetadataStore } from './sqlite-artifact-metadata-store.js';
import {
  revertLastSqliteMigration,
  runSqliteMigrations,
  SqliteMigrationStorage,
} from './sqlite-migrations.js';

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
      INSERT INTO artifacts VALUES (
        'legacy-second', 'Legacy Second', 'artifacts', 'Preserved', 'md',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );
    `);
    legacy.close();

    const store = await SqliteArtifactMetadataStore.open(databasePath);

    expect(store.find('legacy')).toMatchObject({
      id: 'legacy',
      mediaType: 'text/plain',
      title: 'Legacy',
    });
    expect(store.list().map(({ id }) => id)).toEqual(['legacy-second', 'legacy']);
    const database = new DatabaseSync(databasePath);
    expect(database.prepare('SELECT COUNT(*) AS count FROM artifact_migrations').get()).toEqual({
      count: 2,
    });
    database.close();
  });

  it('is idempotent when the store is opened repeatedly', async () => {
    await SqliteArtifactMetadataStore.open(databasePath);
    await SqliteArtifactMetadataStore.open(databasePath);
    const database = new DatabaseSync(databasePath);

    expect(database.prepare('SELECT COUNT(*) AS count FROM artifact_migrations').get()).toEqual({
      count: 2,
    });
    database.close();
  });

  it('downgrades when every row remains representable by the legacy schema', async () => {
    const database = new DatabaseSync(databasePath);
    await runSqliteMigrations(database);
    database
      .prepare(
        `INSERT INTO artifacts
          (id, title, project, description, media_type, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('text', 'Text', 'artifacts', 'safe', 'text/plain', 'created', 'updated');

    await revertLastSqliteMigration(database);

    expect(database.prepare('SELECT id, type FROM artifacts').get()).toEqual({
      id: 'text',
      type: 'txt',
    });
    expect(database.prepare('SELECT COUNT(*) AS count FROM artifact_migrations').get()).toEqual({
      count: 1,
    });
    expect(
      database
        .prepare('PRAGMA table_info(artifacts)')
        .all()
        .map((column) => String(column.name)),
    ).toEqual(['id', 'title', 'project', 'description', 'type', 'created_at', 'updated_at']);
    database.close();
  });

  it('refuses destructive downgrade without changing schema, rows, or history', async () => {
    const database = new DatabaseSync(databasePath);
    await runSqliteMigrations(database);
    database
      .prepare(
        `INSERT INTO artifacts
          (id, title, project, description, media_type, filename, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'binary',
        'Binary',
        'artifacts',
        'unsafe to downgrade',
        'image/png',
        'preview.png',
        'created',
        'updated',
      );

    await expect(revertLastSqliteMigration(database)).rejects.toThrow(
      'restore a pre-migration snapshot',
    );

    expect(database.prepare('SELECT media_type FROM artifacts WHERE id = ?').get('binary')).toEqual(
      { media_type: 'image/png' },
    );
    expect(database.prepare('SELECT COUNT(*) AS count FROM artifact_migrations').get()).toEqual({
      count: 2,
    });
    expect(tableNames(database)).not.toContain('artifacts_legacy');
    database.close();
  });

  it('refuses unsupported legacy types deterministically, including null', async () => {
    const database = new DatabaseSync(databasePath);
    try {
      database.exec(`
        CREATE TABLE artifacts (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          project TEXT NOT NULL,
          description TEXT NOT NULL,
          type TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO artifacts VALUES ('bad-first', 'Bad', 'p', 'd', 'exe', 'created', 'updated');
        INSERT INTO artifacts VALUES ('bad-second', 'Bad', 'p', 'd', 'wat', 'created', 'updated');
        INSERT INTO artifacts VALUES ('bad-null', 'Bad', 'p', 'd', NULL, 'created', 'updated');
      `);

      await expect(runSqliteMigrations(database)).rejects.toThrow(
        'artifact "bad-first": unsupported legacy type "exe"',
      );
      database.prepare("DELETE FROM artifacts WHERE id IN ('bad-first', 'bad-second')").run();
      await expect(runSqliteMigrations(database)).rejects.toThrow(
        'artifact "bad-null": unsupported legacy type "null"',
      );
      expect(database.prepare('SELECT type FROM artifacts WHERE id = ?').get('bad-null')).toEqual({
        type: null,
      });
      expect(tableNames(database)).not.toContain('artifacts_binary');
    } finally {
      database.close();
    }
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
