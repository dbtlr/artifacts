import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { Umzug } from 'umzug';
import type { MigrationParams, RunnableMigration, UmzugStorage } from 'umzug';

import { MIGRATIONS_DIR } from '../migrations-dir.js';

const MIGRATIONS_TABLE = 'artifact_migrations';

// Records applied migrations. It never opens or closes a transaction: the
// runner holds one write lock across the whole run.
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

  async logMigration({ name }: MigrationParams<DatabaseSync>): Promise<void> {
    this.database
      .prepare(`INSERT INTO ${MIGRATIONS_TABLE} (name, executed_at) VALUES (?, ?)`)
      .run(name, new Date().toISOString());
  }

  async unlogMigration({ name }: MigrationParams<DatabaseSync>): Promise<void> {
    this.database.prepare(`DELETE FROM ${MIGRATIONS_TABLE} WHERE name = ?`).run(name);
  }
}

// Loads the shared migrations: every `NNNN-name.sql` file directly in
// `directory`, applied in file-name order and recorded under its name without
// `.sql`. `wrangler d1 migrations apply` reads the same files. An optional
// `down/NNNN-name.sql` reverts a migration on Node; D1 has no down migrations.
// Without a down file, reverting refuses: umzug would otherwise drop the
// history row and leave the schema in place. The files hold no BEGIN or
// COMMIT: the runner wraps them in its own transaction, and D1 rejects both.
export function loadSqlMigrations(directory: string): RunnableMigration<DatabaseSync>[] {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => entry.name)
    .toSorted()
    .map((file) => {
      const name = basename(file, '.sql');
      const path = join(directory, file);
      const upSql = readFileSync(path, 'utf8');
      const downPath = join(directory, 'down', file);
      const downSql = existsSync(downPath) ? readFileSync(downPath, 'utf8') : undefined;
      return {
        down: async ({ context }) => {
          if (downSql === undefined) {
            throw new Error(`Cannot revert migration ${name}: it has no down file`);
          }
          context.exec(downSql);
        },
        name,
        path,
        up: async ({ context }) => {
          context.exec(upSql);
        },
      };
    });
}

// Runs one umzug command inside a single BEGIN IMMEDIATE transaction, so the
// executed set is read under the same lock that applies the migrations: a
// second process opening the database waits, then sees them as applied. Any
// failure rolls back every migration of the run along with its history.
async function withMigrator(
  database: DatabaseSync,
  migrations: RunnableMigration<DatabaseSync>[],
  command: (migrator: Umzug<DatabaseSync>) => Promise<unknown>,
): Promise<void> {
  database.exec('BEGIN IMMEDIATE');
  try {
    const migrator = new Umzug({
      context: database,
      logger: undefined,
      migrations,
      storage: new SqliteMigrationStorage(database),
    });
    await command(migrator);
    database.exec('COMMIT');
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {
      // Preserve the migration error that triggered cleanup.
    }
    throw error;
  }
}

export async function runSqliteMigrations(
  database: DatabaseSync,
  migrations: RunnableMigration<DatabaseSync>[] = loadSqlMigrations(MIGRATIONS_DIR),
): Promise<void> {
  await withMigrator(database, migrations, (migrator) => migrator.up());
}

export async function revertLastSqliteMigration(
  database: DatabaseSync,
  migrations: RunnableMigration<DatabaseSync>[] = loadSqlMigrations(MIGRATIONS_DIR),
): Promise<void> {
  await withMigrator(database, migrations, (migrator) => migrator.down());
}
