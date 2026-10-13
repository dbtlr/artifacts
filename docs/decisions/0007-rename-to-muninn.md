---
type: adr
title: ADR-0007 - The product is named Muninn, and the old variable prefix stops startup
description: The product is renamed from Artifacts to Muninn, and its variables from ARTIFACTS_* to MUNINN_* with no aliases. Any ARTIFACTS_* variable stops startup. An artifact keeps its name, as do its links and storage names.
status: accepted
created: 2026-10-13
modified: 2026-10-13
---
# ADR-0007 - The product is named Muninn, and the old variable prefix stops startup

## Context

The name Artifacts is already used by Claude Artifacts and by CI build artifacts, so it is hard to
search for and easy to confuse. The product is renamed to Muninn. In Norse myth, Muninn is the raven
whose name means memory: it flies out and comes back to report what it saw.

Owner auth is on exactly when its password variable is set ([ADR-0001](0001-opt-in-owner-auth.md)).
After a rename with no further change, a deployment that still sets `ARTIFACTS_OWNER_PASSWORD` would
start with auth off and give no warning. The other variables would also fall back to their defaults
without a warning.

## Decision

- **The product name changes.** Muninn replaces Artifacts in the package name (`@dbtlr/muninn`),
  the MCP server name (`muninn`), the bare Docker container and image (`muninn`, `muninn:local`),
  the web UI, the server logs, and the documentation.
- **Every variable moves to `MUNINN_*`, with no aliases.** `ARTIFACTS_OWNER_PASSWORD` becomes
  `MUNINN_OWNER_PASSWORD`, and the other variables change the same way. The Cloudflare bindings
  become `MUNINN_DB` and `MUNINN_BUCKET`.
- **An old variable stops startup.** If any variable that starts with `ARTIFACTS_`, in any letter
  case, is set, the server and `pnpm docker:start` stop before they start. The error names each old
  variable and its replacement. It does not include their values. An environment with no such
  variables behaves as before.
- **An artifact keeps its name.** The things the product stores are still artifacts. The MCP tools
  (`add_artifact` and the others), `/a/:id` links, database tables, the `artifacts.db` file, the
  default Docker volumes (`artifacts-files`, `artifacts-database`, `artifacts-thumbs`), and the
  session cookies keep their names. An existing deployment keeps its data, and the owner stays
  logged in.

## Considered options

- **Accept both prefixes for a while.** This needs a rule for when both are set and a date to
  remove the old prefix. The project is pre-alpha with one operator, so a single loud failure is
  simpler.
- **Rename the variables and warn about old ones.** A warning in the logs does not stop an instance
  that starts with auth off.
- **Keep the `ARTIFACTS_` prefix.** This avoids the migration, but the configuration would then use
  a name the product no longer has.
- **Rename the volumes and the database file too.** A deployment that relies on the default volumes
  would start with empty storage, and its data would stay in the old volumes.

## Consequences

- Before upgrading, an operator renames each `ARTIFACTS_*` variable, including the ones in a private
  `docker-compose.yaml`, and registers the MCP server as `muninn` in each agent client.
- With the bare Docker helper, an operator stops and removes the old `artifacts` container before
  the first `pnpm docker:start`. The helper does not know about the old container. If it still runs,
  it holds the port and keeps using the same volumes. Removing it does not remove the volumes.
- The check refuses any variable with the old prefix, including a variable that no version ever
  read.
