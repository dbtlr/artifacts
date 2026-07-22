# Artifacts

Artifacts is a preview environment to allow agents to share files on a persistant url. This means that an agent can write a text, markdown, or html file and share it via a url in chat. The intention is that this will allow the agent the ability to create plans, diagrams, and other artifacts that it can then share the url for, which is especially useful for work with an agent remotely.

The app is a small Hono server-side application — zero client React. Pages are rendered with `hono/jsx` on the server; the only client-side script is a locally-bundled mermaid entry. It is started and managed by the local Docker infrastructure in the ~/homelab-infra project (own docker-compose joining the external `caddy` network, `caddy: artifacts.valhalla.local` label, `.autostart` marker).

Code quality is VitePlus using the defaults from the @dbtlr/tooling project (`toolingPlugin({ node: true })`). Styling is Tailwind v4 with the typography plugin, built via Vite as a static asset the server serves. Node >= 24.

Agents interact with it via a streamable-HTTP MCP endpoint mounted at `/mcp` in the same process (`@hono/mcp` + the official MCP SDK, no auth — the tailnet is the boundary). Tools: `add_artifact`, `update_artifact`, `remove_artifact`, `list_artifacts` (optional project filter), `get_artifact`. When an artifact is added, a fully resolvable link is returned to be able to pass to the user. The base host is configured via `PUBLIC_BASE_URL` — e.g. an app served at `http://localhost:12345` resolves across the tailscale network as `https://artifacts.valhalla.local` via a caddy entry.

Types accepted: `html`, `md`, `txt`.

Artifacts are identified by an opaque server-generated id (nanoid): URL `/a/<id>`, file stored as `<id>.<ext>`. Updates are full content replacement; all metadata fields are patchable; renames never change the URL. Remove deletes both file and metadata row.

HTML documents are displayed as is (same-origin — accepted risk, content is self-authored on a private network). Markdown and text documents are rendered via a standard template: server-side markdown with shiki syntax highlighting, mermaid code blocks, an auto-generated table of contents, and `prefers-color-scheme` dark mode. Text renders in the same chrome inside `<pre>`.

Documents are intended to be easy to read on both desktop and mobile. Color choice should be simple and easy to read, as well as font choice.

Artifact files live in `data/artifacts/` and metadata in a sqlite database (`node:sqlite`) at `data/artifacts.db` — path env-configurable, not managed by `git`, bind-mounted in Docker so data survives rebuilds.

An Artifact should have a title, a project, and short description added with it, that help identify it in list views.

The homepage lists all artifacts most-recent-first with title, project, description, and date added. A project name links to `/p/<project>` — the same list filtered to that project.

An agent-facing skill lives in this repo under `skills/` (symlinked into `~/.claude/skills`), bundling document templates (phased plan, design doc/ADR, status report, diagram-first doc) and teaching MCP usage, including rediscovering an existing artifact via `list_artifacts` to update rather than duplicate.

## How We Work (addendum)

This project currently has no upstream repo, which means norm PR workflows are not required for this repository. We still work in worktrees, to assist in agent isolation, however merging happens directly to main
