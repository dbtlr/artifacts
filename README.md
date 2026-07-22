# Artifacts

Artifacts is a small preview environment for agent-generated documents. An
agent writes an HTML, Markdown, or text file through the MCP endpoint and
gets back a persistent URL it can share in chat — handy for plans, diagrams,
status reports, and other artifacts produced while working remotely. Pages
are server-rendered (Hono + `hono/jsx`, no client-side framework); HTML
artifacts are served as-is, while Markdown and text render in a readable
standard template. The homepage lists every artifact, most recent first,
filterable by project.

## Quickstart

Local development:

```sh
pnpm install
pnpm dev
```

Deploy (Docker):

```sh
docker compose up -d
```

The compose file builds the image, joins the external `caddy` network, and
bind-mounts `./data` for the sqlite database and artifact content — data
survives rebuilds and container restarts. Run it from the stable checkout
that this project lives in day to day, not a disposable worktree, so `./data`
isn't orphaned when the worktree goes away. Bring it down with
`docker compose down`.

The container publishes no host ports; it's reachable only via the `caddy`
reverse proxy, using the hostname configured in `PUBLIC_BASE_URL` (see
below) and the `caddy: <hostname>` label in `docker-compose.yaml`.

## Connecting an agent

Agents talk to Artifacts over a streamable-HTTP MCP endpoint mounted at
`/mcp`, exposing five tools: `add_artifact`, `update_artifact`,
`remove_artifact`, `list_artifacts`, and `get_artifact`. No auth is required
— the boundary is network access (the tailnet/caddy network), not a token.

Register it with the `claude` CLI:

```sh
claude mcp add --transport http artifacts https://artifacts.valhalla.local/mcp --scope user
```

`--scope user` makes the server available across all of that user's
projects rather than just the current one. Any MCP-capable client that
supports the streamable-HTTP transport can connect to the same URL — the
registration step above is `claude`-specific, not a requirement of the
protocol.

The hostname in that URL comes from the deployment's `PUBLIC_BASE_URL`
environment variable (set in `docker-compose.yaml`), which is also what the
server uses to build the resolvable URLs it returns from `add_artifact` and
`update_artifact`. Point `PUBLIC_BASE_URL` and the registration command at
whatever hostname your `caddy` (or other reverse proxy) config actually
serves.
