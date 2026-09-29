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

By default, Artifacts has no authentication or authorization. Run it that way only on a trusted
internal network or loopback interface. To reach it from elsewhere, set an owner password (see
[Owner login](#owner-login)) and serve it over HTTPS, or put an authentication-capable proxy in front
of it.

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

When an owner password is set, `/mcp` requires an API key. Log in, open **API keys** in the
gallery header, and create a key. The page shows the key once. Give it to the agent in an
environment variable, here `ARTIFACTS_API_KEY`:

```sh
codex mcp add artifacts --url http://localhost:4242/mcp --bearer-token-env-var ARTIFACTS_API_KEY
claude mcp add --transport http --scope user artifacts http://localhost:4242/mcp \
  --header "Authorization: Bearer $ARTIFACTS_API_KEY"
```

The server exposes `add_artifact`, `remove_artifact`, `list_artifacts`, `list_collections`, and
`get_artifact`. Artifacts are immutable: there is no update tool. A revision or variation is a new
artifact, usually in the same collection, so earlier versions keep their links.

Text artifacts use `content`; binary artifacts use canonical `mediaType`, a safe `filename`, and
strictly encoded `contentBase64`. Binary content is omitted from add, list, and ordinary get
responses. Pass `includeContent: true` to `get_artifact` when the bytes are actually needed. The
decoded size limit is 10 MiB, and the HTTP body guard may reject an oversized base64 request before
an MCP tool result can be returned.

Use an optional shared `collection` to keep a document and its independent image or PDF artifacts
discoverable together. `list_artifacts` filters collections case-insensitively, while
`list_collections` returns their stored display names. An embedding workflow is:

1. Add the binary artifact and retain the absolute `url` returned by the server.
2. Put that URL in an HTML `<img>` element or Markdown image expression.
3. Add the containing document with the same collection.

To replace an embedded file, add the new file and then a new version of the document that embeds
it. Removing a file can break every document that embeds it; collections group artifacts for
discovery but do not create ownership or cascading deletion.

HTML artifacts are served with a `Content-Security-Policy: sandbox allow-scripts` header. Their
scripts run, but in an opaque origin that is separate from the Artifacts server, and their requests
carry `Origin: null`. As a result, an HTML artifact cannot use `localStorage`, `sessionStorage`,
IndexedDB, or cookies, cannot read responses from other Artifacts routes, and cannot submit forms.
The `/mcp` endpoint refuses requests with `Origin: null`, so artifact scripts cannot create or remove
artifacts. Links that open a new window, such as `target="_blank"`, and `alert()` dialogs are also
blocked.

Images, stylesheets, and classic scripts that the page loads by URL still work, including embedded
`/a/:id` images. Loads that use CORS, such as `<script type="module">` or elements with a
`crossorigin` attribute, fail for files from this server; files from other hosts load when the host
sends `Access-Control-Allow-Origin: *`. Frames inside an HTML artifact inherit its sandbox. A PDF in
an `<iframe>`, `<embed>`, or `<object>` does not display, so link to the PDF instead. A Markdown
artifact in an `<iframe>` shows no syntax highlighting or Mermaid diagrams. When an owner password
is set, embedded `/a/:id` files do not load, because the browser does not send the session cookie
on requests from the sandbox.

### Optional artifact skill

The bundled skill teaches an agent how to publish documents, files, and their revisions, how to embed
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
| `ARTIFACTS_THUMBS_MOUNT` | `artifacts-thumbs` | Separate Docker volume name or existing absolute host directory for rendered gallery previews. |
| `ARTIFACTS_OWNER_PASSWORD` | unset | Turns on owner login; see [Owner login](#owner-login). Passed to the container by name, so the value does not appear on the Docker command line. |

Named volumes survive container replacement and `pnpm docker:stop`. The three mounts must be
different. Absolute bind-mount directories must exist and be writable from the container by the
non-root `node` user (uid 1000); `pnpm docker:start` probes each before replacing an existing
container. The previews mount holds derived data only: it needs no backup, and a container started
without it simply re-renders every preview at boot.

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

Database migrations run automatically at startup from the SQL files in `migrations/`. The
binary-artifact schema recognizes PNG, JPEG, GIF, WebP, SVG, and PDF content with a 10 MiB
per-artifact limit. It can be downgraded only while every row is still a legacy text document and neither filename nor collection metadata
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
| `ARTIFACTS_THUMBS_DIR` | `data/development/thumbs` |
| `ARTIFACTS_CHROMIUM_PATH` | probed: Alpine `chromium`, Linux `google-chrome`, macOS Chrome |
| `ARTIFACTS_OWNER_PASSWORD` | unset: no login |

See `.env.development.example` for copyable overrides. Docker mount variables and direct-runtime
path variables are deliberately different; one is not an alias for the other.

### Owner login

Set `ARTIFACTS_OWNER_PASSWORD` to require a login. When it is unset, there is no login and every
route is open, as described above. A blank value stops the server at startup.

With a password set:

- Every page and every `/a/:id` link redirects to `/login` until the owner logs in. The login form,
  `/assets/*`, and the root icons stay public, so the Docker health check still passes.
- A login lasts 7 days. **Log out** in the gallery header ends it.
- Login allows 10 attempts in any 15-minute window for the whole instance, after which the form
  answers `429` with a `Retry-After` header.
- `/mcp` answers `401` unless the request carries `Authorization: Bearer <key>` with a key from the
  **API keys** page. A session cookie does not open `/mcp`.
- Gallery previews stay as placeholders, and HTML artifacts cannot embed other artifacts.
- Set `ARTIFACTS_PUBLIC_BASE_URL` to the URL the browser uses. Login and logout forms are accepted
  only from that origin or the origin the request arrived on, and an `https:` base URL marks the
  session cookie `Secure`.

Sessions and API keys are stored in the SQLite database, keys only as SHA-256 hashes. Changing the
password and restarting ends every session but keeps API keys; revoke them on the **API keys** page. The design is recorded in [ADR-0001](docs/decisions/0001-opt-in-owner-auth.md).

### Gallery previews

The index shows a screenshot of every artifact. A headless Chromium renders each artifact's own
page after it is created, off the request path, and the JPEG is stored under the
thumbnails directory. Until it exists the card shows a drawn placeholder for the file kind, and a
PDF keeps its placeholder because headless Chromium downloads PDFs instead of drawing them. Previews
are derived data: the server re-renders any that are missing at startup, so the thumbnails directory
needs no backup and no mount. Without a Chromium the server logs one notice and keeps the
placeholders. With an owner password set, previews are not rendered and every card keeps its
placeholder.

A preview is a screenshot of the static document: the render context has JavaScript disabled, so
an artifact's scripts never run on the server host, and a Mermaid fence shows as its source in the
thumbnail. Declarative loads (images, frames, stylesheets) may only GET from the server's own
origin; everything else, including `/mcp` and anything on loopback or the container network, is
blocked at a proxy nobody listens on, and a render that is still busy after 15 seconds is
abandoned.

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

`pnpm test` runs two Vitest projects. `node` runs the ordinary tests. `workers` runs
`*.workers.test.ts` files inside workerd, the local Workers runtime, through
`@cloudflare/vitest-pool-workers`, with Miniflare providing R2 bindings locally. It needs no
Cloudflare account. The R2 adapters run the same store contract suites there that the filesystem
adapters run under Node.

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
policy, and HTML artifacts are served in a script-enabled CSP sandbox with an opaque origin. Gallery
previews are screenshots taken by Alpine's Chromium package, driven by playwright-core from a serial
in-process queue. The Docker image is a two-stage Alpine build that
runs as the non-root `node` user; the application writes only to its two persistence mounts and
the derived thumbnails directory, and Chromium keeps its own scratch profile under the container's
temporary directory.

The metadata and content adapters are deliberately narrow seams for a future hosting requirement,
not a configurable backend system. PostgreSQL, object storage, multipart browser uploads, presigned
uploads, tenancy, permissions, and public hosting remain out of scope. Owner login protects one
owner's instance; it does not share artifacts with anyone else. Artifacts is a preview tool, not a
general-purpose file-sharing service.

## Security and license

Read [SECURITY.md](SECURITY.md) before deploying. Artifacts is available under the [MIT
License](LICENSE).
