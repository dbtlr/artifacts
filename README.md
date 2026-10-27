# Muninn

[![CI](https://github.com/dbtlr/muninn/actions/workflows/verify.yml/badge.svg)](https://github.com/dbtlr/muninn/actions/workflows/verify.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Muninn turns agent-generated Markdown, HTML, and text into persistent links. Its byte-native
storage core also recognizes PNG, JPEG, GIF, WebP, SVG, and PDF files up to 10 MiB each. Images and
PDFs use the same stable `/a/:id` links as documents and are served inline with content-type,
filename, revalidation, and content-sniffing protections. It includes a streamable HTTP MCP server
for creating and managing documents, plus a small server-rendered web interface for reading and
finding them.

> [!WARNING]
> Muninn is unversioned pre-alpha software. It has no compatibility guarantees: configuration,
> storage, MCP tools, and URLs may change or be removed without a migration path.

By default, Muninn has no authentication or authorization. Run it that way only on a trusted
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

Wait until `docker ps` reports the `muninn` container as healthy, then open
<http://localhost:4242>. The MCP endpoint is <http://localhost:4242/mcp>.

```sh
pnpm docker:logs
pnpm docker:stop
```

The helper builds locally, binds only to `127.0.0.1`, and uses the deterministic container name
`muninn`. If an ignored `docker-compose.yaml` exists, the same commands delegate to Docker
Compose so operators can maintain a private topology without committing it.

Before the first start after the rename from Artifacts, run `docker rm -f artifacts` to remove the
old container. Its data stays in the same volumes. Then rename each `ARTIFACTS_*` variable to
`MUNINN_*` and register the MCP server as `muninn`
([ADR-0007](docs/decisions/0007-rename-to-muninn.md)).

## Connect an agent

Replace `http://localhost:4242` in these examples with the URL that your trusted network or proxy
uses to reach the deployment.

Codex:

```sh
codex mcp add muninn --url http://localhost:4242/mcp
```

Claude Code:

```sh
claude mcp add --transport http --scope user muninn http://localhost:4242/mcp
```

When an owner password is set, `/mcp` requires an API key. Log in, open **API keys** in the
gallery header, and create a key. The page shows the key once. Put it in an environment variable,
here `MUNINN_API_KEY`, and then add the server:

```sh
codex mcp add muninn --url http://localhost:4242/mcp --bearer-token-env-var MUNINN_API_KEY
claude mcp add --transport http --scope user muninn http://localhost:4242/mcp \
  --header 'Authorization: Bearer ${MUNINN_API_KEY}'
```

Both agents read the variable each time they connect, so the key is not stored in their
configuration. Keep the single quotes in the Claude Code command: they stop the shell from
expanding the variable, and Claude Code expands `${MUNINN_API_KEY}` itself.

`/mcp` refuses a request whose `Origin` header names any origin but the server's own, with or
without an owner password. Command-line and desktop MCP clients, such as Codex and Claude Code, send
no `Origin` and work. A browser-based MCP client sends the origin of its own page, so it is refused.
For example, MCP Inspector in direct connection mode cannot connect.

The server exposes `add_artifact`, `remove_artifact`, `list_artifacts`, `list_collections`, and
`get_artifact`, and `create_secret_upload`, `claim_secret`, and `secret_status` for
[one-time secrets](#one-time-secrets). Artifacts are immutable: there is no update tool. A revision or variation is a new
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

HTML artifacts are served with a
`Content-Security-Policy: sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-modals`
header ([ADR-0006](docs/decisions/0006-html-artifact-sandbox.md)). Their scripts run, but in an
opaque origin that is separate from the Muninn server, and their requests carry `Origin: null`.
As a result, an HTML artifact cannot use `localStorage`, `sessionStorage`, IndexedDB, or cookies,
cannot read responses from other Muninn routes, and cannot submit forms. The `/mcp` endpoint
refuses requests with `Origin: null` or any other origin but its own, so artifact scripts and other
web pages cannot create or remove artifacts. Links with `target="_blank"` and `window.open()` open a
new window outside the artifact's sandbox, so another site loads as an ordinary page (another
HTML artifact still gets its own sandbox). `alert()`, `confirm()`, and
`prompt()` dialogs work.

Images, stylesheets, and classic scripts that the page loads by URL still work, including embedded
`/a/:id` images. Loads that use CORS, such as `<script type="module">` or elements with a
`crossorigin` attribute, fail for files from this server; files from other hosts load when the host
sends `Access-Control-Allow-Origin: *`. Frames inside an HTML artifact inherit its sandbox. A PDF in
an `<iframe>`, `<embed>`, or `<object>` does not display, so link to the PDF instead. A Markdown
artifact in an `<iframe>` shows no syntax highlighting or Mermaid diagrams. When an owner password
is set, the browser does not send the session cookie on requests from the sandbox, so embedded
`/a/:id` files load through signed URLs instead. See [Owner login](#owner-login).

### One-time secrets

An agent can send the owner a secret, such as a token or a key file, without the secret passing
through MCP. The agent calls `create_secret_upload` with a `label` (and an optional `filename` and
`ttlSeconds`), then pipes the secret into the returned upload URL:

```sh
<command that prints the secret> | curl -fsS --data-binary @- "$uploadUrl"
```

The command prints only a view link, `/s/<id>#<key>`. If it prints no link, the upload failed: call
`create_secret_upload` again. Do not inspect or echo the input. The secret is stored exactly as
piped, so use a command that adds no trailing newline, such as `printf %s "$TOKEN"`. The upload URL works once and expires after 15
minutes; the secret is at most 64 KiB and expires unread after 24 hours by default (1 hour to 7
days). Opening the link shows the label and a **Reveal once** button. Revealing needs JavaScript,
shows text for copying or offers a file for download, and deletes the secret from Muninn. A read,
expired, or unknown link shows the same "Nothing to reveal" page. `secret_status` takes an id, view
link, or handle and reports `pending`, `read`, `expired`, or `unknown`. Each secret is encrypted
under a key that Muninn does not keep; the key travels only in the link's fragment. See
[ADR-0008](docs/decisions/0008-one-time-secrets.md).

The owner can send an agent a secret the same way. **New secret** in the gallery header opens
`/secrets/new`, which takes a label, the secret, and an expiry of 1 hour, 24 hours (the default), or
7 days. **Seal secret** shows the secret's handle, `sec_<id>.<key>`, once; a refresh does not show it
again. Line breaks typed into the form are stored as LF. Give the handle to the agent, which calls
`claim_secret` with it and pipes the returned download URL into the command that needs the secret:

```sh
curl -fsS -X POST "$downloadUrl" | <command that consumes it>
```

The download URL works once and expires after 5 minutes, and the download deletes the secret from
Muninn. An unknown, read, expired, or mistyped handle, or one claimed too many times in the last
few minutes, gets one error that does not say which. A handle works only through MCP, so with owner
auth on it is useless without an API key.

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
| `MUNINN_PORT` | `4242` | Loopback host and container port used by the Docker helper. |
| `MUNINN_PUBLIC_BASE_URL` | `http://localhost:<MUNINN_PORT>` | Base URL returned for artifacts; must be an absolute HTTP(S) URL without credentials, query, or fragment. |
| `MUNINN_FILES_MOUNT` | `artifacts-files` | Docker volume name or existing absolute host directory for document bodies. |
| `MUNINN_DATABASE_MOUNT` | `artifacts-database` | Separate Docker volume name or existing absolute host directory for SQLite. |
| `MUNINN_THUMBS_MOUNT` | `artifacts-thumbs` | Separate Docker volume name or existing absolute host directory for rendered gallery previews. |
| `MUNINN_OWNER_PASSWORD` | unset | Turns on owner login; see [Owner login](#owner-login). Passed to the container by name, so the value does not appear on the Docker command line. |
| `MUNINN_CLIENT_ADDRESS_HEADER` | unset | With owner login, the header that your proxy sets to the client's address, such as `CF-Connecting-IP`; see [Owner login](#owner-login). |

The server and the Docker helper refuse to start while any variable from before the rename to
Muninn (`ARTIFACTS_*`) is set, and name the `MUNINN_*` variable that replaces it
([ADR-0007](docs/decisions/0007-rename-to-muninn.md)).

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

Direct development uses `.env.development` and an intentionally separate port and paths, so
`pnpm dev` can run beside a Docker instance on the same host:

| Variable | Default |
| --- | --- |
| `MUNINN_PORT` | `4243` |
| `MUNINN_PUBLIC_BASE_URL` | `http://localhost:<MUNINN_PORT>` |
| `MUNINN_FILES_DIR` | `data/development/files` |
| `MUNINN_DATABASE_PATH` | `data/development/database/artifacts.db` |
| `MUNINN_THUMBS_DIR` | `data/development/thumbs` |
| `MUNINN_CHROMIUM_PATH` | probed: Alpine `chromium`, Linux `google-chrome`, macOS Chrome |
| `MUNINN_OWNER_PASSWORD` | unset: no login |
| `MUNINN_CLIENT_ADDRESS_HEADER` | unset: the connection's address |

`MUNINN_PORT` is the one setting to change to move Muninn; the public base URL follows it unless
`MUNINN_PUBLIC_BASE_URL` is set. See `.env.development.example` for copyable overrides. Docker
mount variables and direct-runtime path variables are deliberately different; one is not an alias
for the other.

### Owner login

Set `MUNINN_OWNER_PASSWORD` to require a login. When it is unset, there is no login and every
route is open, as described above. A blank value, or one shorter than 16 characters, stops the
server at startup. Use a long, random password.

With a password set:

- Every page and every `/a/:id` link redirects to `/login` until the owner logs in. The login form,
  `/assets/*`, and the root icons stay public, so the Docker health check still passes.
- A secret's upload URL, download URL, view page, and Reveal need no session: the URL's token and
  the link's key authorize them ([ADR-0008](docs/decisions/0008-one-time-secrets.md)). The
  new-secret page needs the owner's session.
- A login lasts 7 days. **Log out** in the gallery header ends it.
- Login allows 10 attempts from one client address in any 15-minute window, and 100 from all
  addresses together. After that the form answers `429` with a `Retry-After` header. A successful
  login clears the count for its own address only.
- The client address is the connection's address. Behind a reverse proxy, every connection comes
  from the proxy, so all clients share one count. Set `MUNINN_CLIENT_ADDRESS_HEADER` to the
  header that your proxy sets to the client's address: `CF-Connecting-IP` behind Cloudflare, or
  `X-Real-IP` or `X-Forwarded-For` behind a proxy that you configure to set it. For a list header,
  the last entry counts. The server reads no other header, and a request without the named header
  counts against its connection's address. Any client can send this header, so make sure that the
  server is reachable only through the proxy.
- `/mcp` answers `401` unless the request carries `Authorization: Bearer <key>` with a key from the
  **API keys** page. A session cookie does not open `/mcp`.
- HTML artifacts still show embedded artifacts. When an HTML artifact is added, the server records
  each `/a/:id` URL in the `src`, `srcset`, `poster`, or `href` of an `img`, `source`, `iframe`,
  `video`, `audio`, or `link` element. The URL must be root-relative or start with
  `MUNINN_PUBLIC_BASE_URL`, and it may have a fragment but no query. Each view replaces those
  URLs with signed URLs that work for 10 to 15 minutes. Views in the same clock five minutes get the
  same URLs, so the browser can reuse cached embeds. URLs that scripts build, and CSS `url()`, are
  not signed and do not load. Markdown artifacts sign the images in their rendering the same way.
- Gallery previews still render. The renderer reads each artifact through a signed URL that works
  for 60 seconds and for that one artifact only. An expired or altered signature gets `403`.
- Set `MUNINN_PUBLIC_BASE_URL` to the URL the browser uses. Login and logout forms are accepted
  only from that origin or the origin the request arrived on, and an `https:` base URL marks the
  session cookie `Secure`.

Sessions, API keys, and the hourly keys that sign URLs are stored in the SQLite database, API keys
only as SHA-256 hashes. Changing the password and restarting ends every session but keeps API keys;
revoke them on the **API keys** page, one at a time or all at once. The page shows when each key
was created and last used. The design is recorded in
[ADR-0001](docs/decisions/0001-opt-in-owner-auth.md).

### Gallery previews

The index shows a screenshot of every artifact. A headless Chromium renders each artifact's own
page after it is created, off the request path, and the JPEG is stored under the
thumbnails directory. Until it exists the card shows a drawn placeholder for the file kind, and a
PDF keeps its placeholder because headless Chromium downloads PDFs instead of drawing them. Previews
are derived data: the server re-renders any that are missing at startup, so the thumbnails directory
needs no backup and no mount. Without a Chromium the server logs one notice and keeps the
placeholders.

A preview is a screenshot of the static document: the render context has JavaScript disabled, so
an artifact's scripts never run on the server host, and a Mermaid fence shows as its source in the
thumbnail. Declarative loads (images, frames, stylesheets) may only GET from the server's own
origin; everything else, including `/mcp` and anything on loopback or the container network, is
blocked at a proxy nobody listens on, and a render that is still busy after 15 seconds is
abandoned. A load of a URL under `MUNINN_PUBLIC_BASE_URL`, such as an artifact embedded by the
URL that `add_artifact` returned, is redirected to the same path on the server's own origin, so the
embed shows in the preview without the renderer reaching the public address.

## Run on Cloudflare Workers (experimental)

Muninn also runs as a Cloudflare Worker, with metadata in D1, content in R2, and the stylesheet,
scripts, and icons in Workers Static Assets
([ADR-0009](docs/decisions/0009-cloudflare-workers-profile.md)). `src/worker.ts` is the entry and
`wrangler.jsonc` configures it. Workers Paid is the supported plan: on the free plan, a request
gets 10 ms of CPU, and rendering a Markdown artifact of a few kilobytes when it is saved takes
longer.

The Worker always requires an owner password. Until `MUNINN_OWNER_PASSWORD` (16 characters or
more) and `MUNINN_PUBLIC_BASE_URL` are both valid, it answers every request with a plain-text error
that names the setting. To deploy:

```sh
pnpm exec wrangler login
pnpm exec wrangler d1 create muninn --binding MUNINN_DB --update-config
pnpm worker:deploy
pnpm exec wrangler secret put MUNINN_OWNER_PASSWORD
pnpm exec wrangler secret put MUNINN_PUBLIC_BASE_URL
```

- Create the `muninn` database once, before the first deploy: `pnpm worker:deploy` applies
  `migrations/` to it before it deploys the Worker. `--binding MUNINN_DB` makes Wrangler record
  it on the existing binding rather than add a second one. The first deploy also creates the R2
  bucket.
- Wrangler writes the database and bucket IDs into `wrangler.jsonc`, which is a tracked file.
  Commit that change on the branch you deploy from, and leave it out of pull requests to this
  repository.
- Set `MUNINN_PUBLIC_BASE_URL` to the Worker's URL, such as
  `https://muninn.<your-subdomain>.workers.dev`. Set it as a secret, not a variable:
  `wrangler deploy` replaces variables that `wrangler.jsonc` does not list, and it lists none.
- Login limits count each client by the `CF-Connecting-IP` header that Cloudflare sets.
  `MUNINN_CLIENT_ADDRESS_HEADER` is not read.
- A Cron Trigger removes expired one-time secrets every 10 minutes.
- Gallery previews stay as placeholders. The Worker has no preview renderer yet.

To run the Worker locally, put both settings in an ignored `.dev.vars` file, apply the migrations
with `pnpm exec wrangler d1 migrations apply MUNINN_DB --local`, and run `pnpm worker:dev`.
`wrangler dev` trusts a `CF-Connecting-IP` header that the client sends, so do not expose it
beyond localhost.

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
pnpm worker:check
```

`pnpm worker:check` builds the Worker without deploying it and fails if its bundle reaches a
Node-only module, such as `node:sqlite` or `@hono/node-server`.

`pnpm test` runs two Vitest projects. `node` runs the ordinary tests. `workers` runs
`*.workers.test.ts` files inside workerd, the local Workers runtime, through
`@cloudflare/vitest-pool-workers`, with Miniflare providing D1 and R2 bindings locally. It needs
no Cloudflare account. The D1 and R2 adapters run the same store contract suites there that the
SQLite and filesystem adapters run under Node, and the D1 tests apply the shared `migrations/`
files first.

`pnpm start` runs an existing build with development storage defaults. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the contribution workflow.

## Troubleshooting

- `Docker CLI not found`: install Docker Desktop or Docker Engine, then rerun `pnpm docker:check`.
- `Docker daemon is unavailable`: start Docker Desktop or the Docker service.
- `Docker Compose v2 is unavailable`: install the Compose plugin or remove/rename the local
  `docker-compose.yaml` to use the bare-Docker path.
- A mount error before startup: use different valid volume names, or create the absolute files and
  database directories first. Commas are not supported in mount sources.
- Returned links point at the wrong host: set `MUNINN_PUBLIC_BASE_URL` to the externally reachable
  base URL and restart.
- Port 4242 is occupied: set `MUNINN_PORT` in `.env`. The public base URL follows it unless
  `MUNINN_PUBLIC_BASE_URL` is set.

## Architecture

Muninn is a Node.js 24 TypeScript application built on Hono. The same process serves the web UI,
artifact routes, static assets, and the streamable HTTP MCP endpoint at `/mcp`. Metadata lives in
SQLite while byte-native content lives in a separate files directory. The MCP adapter uses bounded
base64 for binary transport; base64 is not part of the storage or service model. Markdown is rendered once, when it
is created, and its HTML is stored in SQLite as derived data, so a view parses no Markdown; a missing rendering, or
one from an older renderer version, is rendered again on the next view. Code highlighting and Mermaid diagrams are
rendered in the browser. Allowlisted images and PDFs
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
owner's instance; it does not share artifacts with anyone else. Muninn is a preview tool, not a
general-purpose file-sharing service.

## Security and license

Read [SECURITY.md](SECURITY.md) before deploying. Muninn is available under the [MIT
License](LICENSE).
