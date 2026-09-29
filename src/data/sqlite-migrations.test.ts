import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { RunnableMigration } from 'umzug';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';

import { MIGRATIONS_DIR } from '../migrations-dir.js';
import { SqliteArtifactMetadataStore } from './sqlite-artifact-metadata-store.js';
import {
  loadSqlMigrations,
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

// The schema as of 0002, before immutability dropped updated_at.
const throughBinarySchema = loadSqlMigrations(MIGRATIONS_DIR).slice(0, 2);
// The schema as of 0003, when updated_at was dropped.
const throughImmutableSchema = loadSqlMigrations(MIGRATIONS_DIR).slice(0, 3);
const shippedMigrationCount = loadSqlMigrations(MIGRATIONS_DIR).length;

function columnNames(database: DatabaseSync): string[] {
  return database
    .prepare('PRAGMA table_info(artifacts)')
    .all()
    .map((column) => String(column.name));
}

function tableNames(database: DatabaseSync): string[] {
  return database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => String(row.name));
}

describe('SQL migration files', () => {
  it('applies files in name order and reverts with the matching down file', async () => {
    const migrationsDir = join(directory, 'migrations');
    mkdirSync(join(migrationsDir, 'down'), { recursive: true });
    writeFileSync(
      join(migrationsDir, '0002-add-notes.sql'),
      'ALTER TABLE items ADD COLUMN notes TEXT;',
    );
    writeFileSync(join(migrationsDir, '0001-create-items.sql'), 'CREATE TABLE items (id TEXT);');
    writeFileSync(
      join(migrationsDir, 'down', '0002-add-notes.sql'),
      'ALTER TABLE items DROP COLUMN notes;',
    );
    writeFileSync(join(migrationsDir, 'README.md'), 'Not a migration.');
    const migrations = loadSqlMigrations(migrationsDir);
    const database = new DatabaseSync(databasePath);

    await runSqliteMigrations(database, migrations);

    expect(
      database
        .prepare('SELECT name FROM artifact_migrations ORDER BY rowid')
        .all()
        .map((row) => String(row.name)),
    ).toEqual(['0001-create-items', '0002-add-notes']);
    expect(
      database
        .prepare('PRAGMA table_info(items)')
        .all()
        .map((column) => column.name),
    ).toEqual(['id', 'notes']);

    await revertLastSqliteMigration(database, migrations);

    expect(
      database
        .prepare('PRAGMA table_info(items)')
        .all()
        .map((column) => column.name),
    ).toEqual(['id']);
    await expect(revertLastSqliteMigration(database, migrations)).rejects.toThrow(
      'Cannot revert migration 0001-create-items: it has no down file',
    );
    expect(tableNames(database)).toContain('items');
    expect(database.prepare('SELECT name FROM artifact_migrations').get()).toEqual({
      name: '0001-create-items',
    });
    database.close();
  });
});

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

    await expect(store.find('legacy')).resolves.toMatchObject({
      id: 'legacy',
      mediaType: 'text/plain',
      title: 'Legacy',
    });
    expect((await store.list()).map(({ id }) => id)).toEqual(['legacy-second', 'legacy']);
    const database = new DatabaseSync(databasePath);
    expect(database.prepare('SELECT COUNT(*) AS count FROM artifact_migrations').get()).toEqual({
      count: shippedMigrationCount,
    });
    database.close();
  });

  it('is idempotent when the store is opened repeatedly', async () => {
    await SqliteArtifactMetadataStore.open(databasePath);
    await SqliteArtifactMetadataStore.open(databasePath);
    const database = new DatabaseSync(databasePath);

    expect(database.prepare('SELECT COUNT(*) AS count FROM artifact_migrations').get()).toEqual({
      count: shippedMigrationCount,
    });
    database.close();
  });

  it('downgrades when every row remains representable by the legacy schema', async () => {
    const database = new DatabaseSync(databasePath);
    await runSqliteMigrations(database, throughBinarySchema);
    database
      .prepare(
        `INSERT INTO artifacts
          (id, title, project, description, media_type, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('text', 'Text', 'artifacts', 'safe', 'text/plain', 'created', 'updated');

    await revertLastSqliteMigration(database, throughBinarySchema);

    expect(database.prepare('SELECT id, type FROM artifacts').get()).toEqual({
      id: 'text',
      type: 'txt',
    });
    expect(database.prepare('SELECT COUNT(*) AS count FROM artifact_migrations').get()).toEqual({
      count: 1,
    });
    expect(columnNames(database)).toEqual([
      'id',
      'title',
      'project',
      'description',
      'type',
      'created_at',
      'updated_at',
    ]);
    database.close();
  });

  it('refuses destructive downgrade without changing schema, rows, or history', async () => {
    const database = new DatabaseSync(databasePath);
    await runSqliteMigrations(database, throughBinarySchema);
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

    await expect(revertLastSqliteMigration(database, throughBinarySchema)).rejects.toThrow(
      'restore a pre-migration snapshot',
    );

    expect(database.prepare('SELECT media_type FROM artifacts WHERE id = ?').get('binary')).toEqual(
      { media_type: 'image/png' },
    );
    expect(database.prepare('SELECT COUNT(*) AS count FROM artifact_migrations').get()).toEqual({
      count: 2,
    });
    expect(tableNames(database)).not.toContain('artifacts_legacy');
    expect(tableNames(database)).not.toContain('migration_guard');
    database.close();
  });

  it('drops updated_at from existing rows, keeping their order', async () => {
    const database = new DatabaseSync(databasePath);
    await runSqliteMigrations(database, throughBinarySchema);
    const insert = database.prepare(
      `INSERT INTO artifacts
        (id, title, project, description, media_type, created_at, updated_at)
       VALUES (?, 'Title', 'artifacts', 'kept', 'text/plain', ?, ?)`,
    );
    insert.run('first', '2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z');
    insert.run('second', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    database.close();

    const store = await SqliteArtifactMetadataStore.open(databasePath);

    expect((await store.list()).map(({ id }) => id)).toEqual(['second', 'first']);
    await expect(store.find('first')).resolves.toEqual({
      createdAt: '2026-01-01T00:00:00.000Z',
      description: 'kept',
      id: 'first',
      mediaType: 'text/plain',
      project: 'artifacts',
      title: 'Title',
    });
    const reopened = new DatabaseSync(databasePath);
    expect(columnNames(reopened)).not.toContain('updated_at');
    reopened.close();
  });

  it('restores updated_at from created_at on downgrade', async () => {
    const database = new DatabaseSync(databasePath);
    await runSqliteMigrations(database, throughImmutableSchema);
    database
      .prepare(
        `INSERT INTO artifacts (id, title, project, description, media_type, created_at)
         VALUES ('text', 'Text', 'artifacts', 'safe', 'text/plain', 'created')`,
      )
      .run();

    await revertLastSqliteMigration(database, throughImmutableSchema);

    expect(database.prepare('SELECT created_at, updated_at FROM artifacts').get()).toEqual({
      created_at: 'created',
      updated_at: 'created',
    });
    database.close();
  });

  it('refuses unsupported legacy types, including null, without changing the rows', async () => {
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
        'a row has a type other than html, md, or txt',
      );
      database.prepare("DELETE FROM artifacts WHERE id IN ('bad-first', 'bad-second')").run();
      await expect(runSqliteMigrations(database)).rejects.toThrow(
        'a row has a type other than html, md, or txt',
      );
      expect(database.prepare('SELECT type FROM artifacts WHERE id = ?').get('bad-null')).toEqual({
        type: null,
      });
      expect(tableNames(database)).not.toContain('artifacts_binary');
      expect(tableNames(database)).not.toContain('migration_guard');
    } finally {
      database.close();
    }
  });

  it('rolls back every migration of a failed run, including its history', async () => {
    const database = new DatabaseSync(databasePath);
    const succeedingMigration: RunnableMigration<DatabaseSync> = {
      name: 'working-migration',
      up: async ({ context }) => {
        context.exec('CREATE TABLE applied_first (id TEXT)');
      },
    };
    const failingMigration: RunnableMigration<DatabaseSync> = {
      name: 'broken-migration',
      up: async ({ context }) => {
        context.exec('CREATE TABLE must_not_survive (id TEXT)');
        throw new Error('injected migration failure');
      },
    };

    await expect(
      runSqliteMigrations(database, [succeedingMigration, failingMigration]),
    ).rejects.toThrow('injected migration failure');
    expect(tableNames(database)).toEqual([]);
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

  it('surfaces a history-write error', async () => {
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

  it('skips migrations another process applied while this one waited for the lock', async () => {
    // Another process has already started migrating: it holds the write lock
    // and has recorded every migration, but has not committed yet.
    const migrateScript = `
      const { DatabaseSync } = require('node:sqlite');
      const database = new DatabaseSync(process.argv[1]);
      database.exec('CREATE TABLE artifact_migrations (name TEXT PRIMARY KEY, executed_at TEXT NOT NULL)');
      database.exec('BEGIN IMMEDIATE');
      database.exec(\`
        CREATE TABLE artifacts (
          id TEXT PRIMARY KEY, title TEXT NOT NULL, project TEXT NOT NULL,
          description TEXT NOT NULL, media_type TEXT NOT NULL,
          collection TEXT COLLATE NOCASE, filename TEXT, created_at TEXT NOT NULL
        );
        INSERT INTO artifact_migrations VALUES
          ('0001-initial-artifacts-schema', 'now'),
          ('0002-binary-artifact-schema', 'now'),
          ('0003-drop-artifact-updated-at', 'now');
      \`);
      process.stdout.write('locked');
      setTimeout(() => { database.exec('COMMIT'); database.close(); }, 100);
    `;
    const migrateProcess = spawn(process.execPath, ['-e', migrateScript, databasePath], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const exit = once(migrateProcess, 'exit');
    await once(migrateProcess.stdout, 'data');

    await expect(SqliteArtifactMetadataStore.open(databasePath)).resolves.toBeDefined();
    await exit;
    const database = new DatabaseSync(databasePath);
    expect(database.prepare('SELECT COUNT(*) AS count FROM artifact_migrations').get()).toEqual({
      count: shippedMigrationCount,
    });
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
