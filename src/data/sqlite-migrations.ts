import type { DatabaseSync } from 'node:sqlite';

import type { MigrationParams, RunnableMigration, UmzugStorage } from 'umzug';

const MIGRATIONS_TABLE = 'artifact_migrations';

export class SqliteMigrationStorage implements UmzugStorage<DatabaseSync> {
  private readonly database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.database = database;
    database.exec(
      `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (name TEXT PRIMARY KEY, executed_at TEXT NOT NULL)`,
    );
  }

  executed(): Promise<string[]> {
    const rows = this.database
      .prepare(`SELECT name FROM ${MIGRATIONS_TABLE} ORDER BY executed_at, rowid`)
      .all();
    return Promise.resolve(rows.map((row) => String(row.name)));
  }

  logMigration({ name }: MigrationParams<DatabaseSync>): Promise<void> {
    this.database
      .prepare(`INSERT INTO ${MIGRATIONS_TABLE} (name, executed_at) VALUES (?, ?)`)
      .run(name, new Date().toISOString());
    return Promise.resolve();
  }

  unlogMigration({ name }: MigrationParams<DatabaseSync>): Promise<void> {
    this.database.prepare(`DELETE FROM ${MIGRATIONS_TABLE} WHERE name = ?`).run(name);
    return Promise.resolve();
  }
}

export const sqliteMigrations: RunnableMigration<DatabaseSync>[] = [
  {
    down: async ({ context: database }) => {
      database.exec(`
        DROP INDEX IF EXISTS idx_artifacts_created_at;
        DROP INDEX IF EXISTS idx_artifacts_project;
        DROP TABLE IF EXISTS artifacts;
      `);
    },
    name: '0001-initial-artifacts-schema',
    up: async ({ context: database }) => {
      // CREATE IF NOT EXISTS makes this migration both a fresh-install schema
      // and a safe baseline for databases created before migration tracking.
      database.exec(`
        CREATE TABLE IF NOT EXISTS artifacts (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          project TEXT NOT NULL,
          description TEXT NOT NULL,
          type TEXT NOT NULL CHECK (type IN ('html','md','txt')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_artifacts_project ON artifacts(project);
        CREATE INDEX IF NOT EXISTS idx_artifacts_created_at ON artifacts(created_at);
      `);
    },
  },
];
