# Artifacts

[![CI](https://github.com/dbtlr/artifacts/actions/workflows/verify.yml/badge.svg)](https://github.com/dbtlr/artifacts/actions/workflows/verify.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Artifacts turns agent-generated Markdown, HTML, and text into persistent links. Its byte-native
storage core also recognizes PNG, JPEG, GIF, WebP, SVG, and PDF files up to 10 MiB each. Images and
PDFs use the same stable `/a/:id` links as documents and are served inline with content-type,
filename, revalidation, and content-sniffing protections. It includes a streamable HTTP MCP server
for creating and managing documents, plus a small server-rendered web interface for reading and
finding them.

> [!WARNING]
> Artifacts is unversioned pre-alpha software. It has no compatibility guarantees: configuration,
> storage, MCP tools, and URLs may change or be removed without a migration path.

Artifacts has no authentication or authorization. Run it only on a trusted internal network or
loopback interface, and put an authentication-capable proxy in front of it before granting broader
network access. Do not expose it directly to the public internet.

## Prerequisites

- Docker with a running Docker daemon for the recommended quickstart.
- Node.js 24 or newer and pnpm 11 for local development.

## Docker quickstart

From the repository root:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm docker:check
pnpm docker:start
```

Wait until `docker ps` reports the `artifacts` container as healthy, then open
<http://localhost:4242>. The MCP endpoint is <http://localhost:4242/mcp>.

```sh
pnpm docker:logs
pnpm docker:stop
```

The helper builds locally, binds only to `127.0.0.1`, and uses the deterministic container name
`artifacts`. If an ignored `docker-compose.yaml` exists, the same commands delegate to Docker
Compose so operators can maintain a private topology without committing it.

## Connect an agent

Replace `http://localhost:4242` in these examples with the URL that your trusted network or proxy
uses to reach the deployment.

Codex:

```sh
codex mcp add artifacts --url http://localhost:4242/mcp
```

Claude Code:

```sh
claude mcp add --transport http --scope user artifacts http://localhost:4242/mcp
```

The server exposes `add_artifact`, `update_artifact`, `remove_artifact`, `list_artifacts`,
`list_collections`, and `get_artifact`.

Text artifacts use `content`; binary artifacts use canonical `mediaType`, a safe `filename`, and
strictly encoded `contentBase64`. Binary content is omitted from add, update, list, and ordinary get
responses. Pass `includeContent: true` to `get_artifact` when the bytes are actually needed. The
decoded size limit is 10 MiB, and the HTTP body guard may reject an oversized base64 request before
an MCP tool result can be returned.

Use an optional shared `collection` to keep a document and its independent image or PDF artifacts
discoverable together. `list_artifacts` filters collections case-insensitively, while
`list_collections` returns their stored display names. An embedding workflow is:

1. Add the binary artifact and retain the absolute `url` returned by the server.
2. Put that URL in an HTML `<img>` element or Markdown image expression.
3. Add or update the containing document with the same collection.

Updating a binary artifact in place preserves its URL. Removing one can break every document that
embeds it; collections group artifacts for discovery but do not create ownership or cascading
deletion.

### Optional artifact skill

The bundled skill teaches an agent when to create or update documents and files, how to embed
returned file URLs, and how to rediscover related artifacts through collections. From the repository
root, install it for the client you use:

Codex:

```sh
mkdir -p ~/.agents/skills
ln -s "$PWD/skills/artifact" ~/.agents/skills/artifact
```

Claude Code:

```sh
mkdir -p ~/.claude/skills
ln -s "$PWD/skills/artifact" ~/.claude/skills/artifact
```

Restart the client after installing the skill. The skill is optional; MCP tools work without it.

## Configuration and persistence

The zero-configuration Docker path needs no `.env` file. Copy `.env.example` to `.env` only to
override Docker defaults.

| Variable | Default | Purpose |
| --- | --- | --- |
| `ARTIFACTS_PORT` | `4242` | Loopback host and container port used by the Docker helper. |
| `ARTIFACTS_PUBLIC_BASE_URL` | `http://localhost:4242` | Base URL returned for artifacts; must be an absolute HTTP(S) URL without credentials, query, or fragment. |
| `ARTIFACTS_FILES_MOUNT` | `artifacts-files` | Docker volume name or existing absolute host directory for document bodies. |
| `ARTIFACTS_DATABASE_MOUNT` | `artifacts-database` | Separate Docker volume name or existing absolute host directory for SQLite. |

Named volumes survive container replacement and `pnpm docker:stop`. The files and database mounts
must be different. Absolute bind-mount directories must exist and be writable from the container by
the non-root `node` user (uid 1000); `pnpm docker:start` probes both before replacing an existing
container.

For a consistent backup, stop the service and treat the SQLite database and stored files as one
backup set. With the default named volumes, export both into a newly created `backups` directory:

```sh
pnpm docker:stop
mkdir -p backups
docker run --rm --mount source=artifacts-files,target=/source,readonly --mount "type=bind,source=$PWD/backups,target=/backup" alpine tar -czf /backup/artifacts-files.tgz -C /source .
docker run --rm --mount source=artifacts-database,target=/source,readonly --mount "type=bind,source=$PWD/backups,target=/backup" alpine tar -czf /backup/artifacts-database.tgz -C /source .
```

For bind mounts, copy the two configured directories while the service is stopped. Restore both
sources from the same backup before restarting.

Database migrations run automatically at startup. The binary-artifact schema recognizes PNG,
JPEG, GIF, WebP, SVG, and PDF content with a 10 MiB per-artifact limit. It can be downgraded
only while every row is still a legacy text document and neither filename nor collection metadata
has been stored. Once binary rows or new metadata exist, the guarded down migration refuses without
changing the database; restore both persistence sources from the same pre-migration snapshot
instead. Pre-migration builds cannot safely read an upgraded database. The down migration is a
programmatic recovery primitive, not an operator CLI command; no supported `pnpm` command invokes
it.

Direct development uses `.env.development` and intentionally separate paths:

| Variable | Default |
| --- | --- |
| `ARTIFACTS_PORT` | `3000` |
| `ARTIFACTS_PUBLIC_BASE_URL` | `http://localhost:3000` |
| `ARTIFACTS_FILES_DIR` | `data/development/files` |
| `ARTIFACTS_DATABASE_PATH` | `data/development/database/artifacts.db` |

See `.env.development.example` for copyable overrides. Docker mount variables and direct-runtime
path variables are deliberately different; one is not an alias for the other.

## Development

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm dev
```

Before opening a pull request:

```sh
pnpm fmt
pnpm lint
pnpm test
pnpm build
```

`pnpm start` runs an existing build with development storage defaults. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the contribution workflow.

## Troubleshooting

- `Docker CLI not found`: install Docker Desktop or Docker Engine, then rerun `pnpm docker:check`.
- `Docker daemon is unavailable`: start Docker Desktop or the Docker service.
- `Docker Compose v2 is unavailable`: install the Compose plugin or remove/rename the local
  `docker-compose.yaml` to use the bare-Docker path.
- A mount error before startup: use different valid volume names, or create the absolute files and
  database directories first. Commas are not supported in mount sources.
- Returned links point at the wrong host: set `ARTIFACTS_PUBLIC_BASE_URL` to the externally reachable
  base URL and restart.
- Port 4242 is occupied: set `ARTIFACTS_PORT` and the matching `ARTIFACTS_PUBLIC_BASE_URL` in `.env`.

## Architecture

Artifacts is a Node.js 24 TypeScript application built on Hono. The same process serves the web UI,
artifact routes, static assets, and the streamable HTTP MCP endpoint at `/mcp`. Metadata lives in
SQLite while byte-native content lives in a separate files directory. The MCP adapter uses bounded
base64 for binary transport; base64 is not part of the storage or service model. Markdown is rendered on the server
with syntax highlighting; Mermaid diagrams are rendered in the browser. Allowlisted images and PDFs
are served directly from `/a/:id`; SVG responses receive an additional restrictive content security
policy. The Docker image is a two-stage Alpine build that runs as the non-root `node` user and writes
only to its two persistence mounts.

The metadata and content adapters are deliberately narrow seams for a future hosting requirement,
not a configurable backend system. PostgreSQL, object storage, multipart browser uploads, presigned
uploads, tenancy, permissions, and public hosting remain out of scope. Artifacts is a trusted-network
preview tool, not a general-purpose file-sharing service.

## Security and license

Read [SECURITY.md](SECURITY.md) before deploying. Artifacts is available under the [MIT
License](LICENSE).
