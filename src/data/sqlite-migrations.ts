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
    try {
      this.database.exec('ROLLBACK');
    } catch {
      // Preserve the migration error that triggered cleanup.
    }
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

export async function revertLastSqliteMigration(
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
  await migrator.down();
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
  {
    down: async ({ context: database }) => {
      const incompatible = database
        .prepare(
          `SELECT id FROM artifacts
           WHERE media_type NOT IN ('text/html', 'text/markdown', 'text/plain')
              OR collection IS NOT NULL
              OR filename IS NOT NULL
           LIMIT 1`,
        )
        .get();
      if (incompatible !== undefined) {
        throw new Error(
          'Cannot downgrade binary artifact schema: current data is not representable by the legacy schema; restore a pre-migration snapshot instead',
        );
      }
      database.exec(`
        CREATE TABLE artifacts_legacy (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          project TEXT NOT NULL,
          description TEXT NOT NULL,
          type TEXT NOT NULL CHECK (type IN ('html','md','txt')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO artifacts_legacy
          (id, title, project, description, type, created_at, updated_at)
        SELECT id, title, project, description,
          CASE media_type
            WHEN 'text/html' THEN 'html'
            WHEN 'text/markdown' THEN 'md'
            WHEN 'text/plain' THEN 'txt'
          END,
          created_at, updated_at
        FROM artifacts;
        DROP INDEX IF EXISTS idx_artifacts_collection;
        DROP INDEX IF EXISTS idx_artifacts_created_at;
        DROP INDEX IF EXISTS idx_artifacts_project;
        DROP TABLE artifacts;
        ALTER TABLE artifacts_legacy RENAME TO artifacts;
        CREATE INDEX idx_artifacts_project ON artifacts(project);
        CREATE INDEX idx_artifacts_created_at ON artifacts(created_at);
      `);
    },
    name: '0002-binary-artifact-schema',
    up: async ({ context: database }) => {
      const unsupported = database
        .prepare("SELECT id, type FROM artifacts WHERE type NOT IN ('html', 'md', 'txt') LIMIT 1")
        .get();
      if (unsupported !== undefined) {
        throw new Error(
          `Cannot migrate artifact ${JSON.stringify(String(unsupported.id))}: unsupported legacy type ${JSON.stringify(String(unsupported.type))}`,
        );
      }
      database.exec(`
        CREATE TABLE artifacts_binary (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          project TEXT NOT NULL,
          description TEXT NOT NULL,
          media_type TEXT NOT NULL CHECK (media_type IN (
            'text/html', 'text/markdown', 'text/plain',
            'image/png', 'image/jpeg', 'image/gif', 'image/webp',
            'image/svg+xml', 'application/pdf'
          )),
          collection TEXT COLLATE NOCASE,
          filename TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO artifacts_binary
          (id, title, project, description, media_type, collection, filename, created_at, updated_at)
        SELECT id, title, project, description,
          CASE type
            WHEN 'html' THEN 'text/html'
            WHEN 'md' THEN 'text/markdown'
            WHEN 'txt' THEN 'text/plain'
            ELSE 'unsupported-legacy-type'
          END,
          NULL, NULL, created_at, updated_at
        FROM artifacts ORDER BY rowid;
        DROP INDEX IF EXISTS idx_artifacts_created_at;
        DROP INDEX IF EXISTS idx_artifacts_project;
        DROP TABLE artifacts;
        ALTER TABLE artifacts_binary RENAME TO artifacts;
        CREATE INDEX idx_artifacts_project ON artifacts(project);
        CREATE INDEX idx_artifacts_created_at ON artifacts(created_at);
        CREATE INDEX idx_artifacts_collection ON artifacts(collection COLLATE NOCASE);
      `);
    },
  },
];
