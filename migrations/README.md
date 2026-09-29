# Migrations

These SQL files are the metadata schema history, shared by both runtimes:

- On Node, `src/data/sqlite-migrations.ts` applies them with umzug at startup and records each
  one in `artifact_migrations` under its file name without `.sql`.
- On Cloudflare, `wrangler d1 migrations apply` reads this directory, its default
  `migrations_dir`.

To add a migration, create the next numbered file, for example `0004-add-rendered-html.sql`. Keep
it to SQLite syntax that D1 also accepts, and leave out `BEGIN` and `COMMIT`: the Node runner wraps
the whole run in one transaction, and D1 rejects transaction statements. Never edit or rename a
migration that has shipped.

A migration can have a reverse in `down/` with the same file name. Only the Node runner uses it,
because D1 has no down migrations. Reverting a migration without a down file fails.

To refuse a migration that would lose data, add a guard before the change. A guard inserts one row
into a scratch table whose named `CHECK` constraint fails when the data is unsafe. The constraint
name becomes the error message, and the failure rolls back the whole migration. See
`down/0002-binary-artifact-schema.sql`.
