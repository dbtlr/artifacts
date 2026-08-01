import type { DatabaseSync } from 'node:sqlite';

import { Umzug } from 'umzug';
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

  begin(): void {
    this.database.exec('BEGIN IMMEDIATE');
  }

  rollback(): void {
    this.database.exec('ROLLBACK');
  }

  logMigration({ name }: MigrationParams<DatabaseSync>): Promise<void> {
    try {
      this.database
        .prepare(`INSERT INTO ${MIGRATIONS_TABLE} (name, executed_at) VALUES (?, ?)`)
        .run(name, new Date().toISOString());
      this.database.exec('COMMIT');
      return Promise.resolve();
    } catch (error) {
      this.rollback();
      return Promise.reject(error);
    }
  }

  unlogMigration({ name }: MigrationParams<DatabaseSync>): Promise<void> {
    try {
      this.database.prepare(`DELETE FROM ${MIGRATIONS_TABLE} WHERE name = ?`).run(name);
      this.database.exec('COMMIT');
      return Promise.resolve();
    } catch (error) {
      this.rollback();
      return Promise.reject(error);
    }
  }
}

function transactionalMigrations(
  migrations: RunnableMigration<DatabaseSync>[],
  storage: SqliteMigrationStorage,
): RunnableMigration<DatabaseSync>[] {
  return migrations.map((migration) => {
    const down = migration.down;
    return {
      down:
        down === undefined
          ? undefined
          : async (params) => {
              storage.begin();
              try {
                return await down(params);
              } catch (error) {
                storage.rollback();
                throw error;
              }
            },
      name: migration.name,
      path: migration.path,
      up: async (params) => {
        storage.begin();
        try {
          return await migration.up(params);
        } catch (error) {
          storage.rollback();
          throw error;
        }
      },
    };
  });
}

export async function runSqliteMigrations(
  database: DatabaseSync,
  migrations: RunnableMigration<DatabaseSync>[] = sqliteMigrations,
): Promise<void> {
  const storage = new SqliteMigrationStorage(database);
  const migrator = new Umzug({
    context: database,
    logger: undefined,
    migrations: transactionalMigrations(migrations, storage),
    storage,
  });
  await migrator.up();
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
