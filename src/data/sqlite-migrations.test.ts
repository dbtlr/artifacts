import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { RunnableMigration } from 'umzug';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';

import { SqliteArtifactMetadataStore } from './sqlite-artifact-metadata-store.js';
import { runSqliteMigrations } from './sqlite-migrations.js';

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
});
