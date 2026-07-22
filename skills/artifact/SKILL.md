---
name: artifact
description: Share a plan, design doc, status report, or diagram with a human as a persistent, linkable document via the Artifacts MCP server. Use when the user says "share this as an artifact", "give me a link to the plan", "publish this doc", "post a status update", "put this somewhere I can read it", or "share this with a link" — or whenever a phased plan, design doc/ADR, status report, or diagram is being produced for a human to open in a browser rather than kept as a local file.
---

# Artifact — Share Documents via Persistent Links

Publish a document to the Artifacts server and hand back a URL the user can open on any device. The same URL keeps working across edits, so a living document (a plan that's evolving, a status report that gets refreshed) should be updated in place, not re-created.

## Why This Skill Exists

Documents produced mid-task — a plan, a design doc, a status update, a diagram — are easiest to review as a rendered page with a link, especially when working with the user remotely. Artifacts gives every such document a stable URL; this skill teaches the decision an agent has to make before writing one: update the existing artifact, or create a new one, and with which template and metadata.

## Core Workflow

### Step 1: Look for an existing artifact first

Before creating anything, call `list_artifacts` (pass `project` if you know it) to check whether this document already exists as an artifact.

- **Update beats duplicate for living documents.** A plan, status report, or design doc that's still evolving should be updated via `update_artifact`, not recreated — the URL stays the same across updates, so anyone holding the old link keeps seeing current content.
- **Create only when genuinely new** — a document that hasn't existed before, or a distinct artifact from ones already listed (a new phase's plan is not the same artifact as the previous phase's).
- When updating, `content` is a full replacement, not a diff. If you're editing rather than regenerating from scratch, call `get_artifact` first, edit its content, then `update_artifact` with the result (read-modify-write).

### Step 2: Choose metadata

- **title** — short and human-scannable; it's what shows up in list views. ("Q3 Migration Plan", not "Plan for migrating the thing we discussed.")
- **project** — a stable string per repo or initiative, reused across every artifact in that body of work (matches what `list_artifacts` filters on in Step 1). Pick it once and keep it consistent so Step 1 keeps finding the right artifacts.
- **description** — one line, written for the list view, not the document body.

### Step 3: Choose a type

- **md** (default) — nearly everything: plans, design docs, status reports, diagrams, notes. Renders server-side with syntax-highlighted code, mermaid diagrams, and an auto-generated table of contents (once a document has two or more headings) with anchor links.
- **html** — only for bespoke layouts or visuals a markdown template can't express (custom CSS, non-mermaid diagrams, interactive-free visual layouts). HTML is served as-is — no template chrome, no TOC.
- **txt** — raw output: logs, command transcripts, anything not meant to be formatted.

### Step 4: Pick a template, fill it, write it

Reference the template file directly rather than retyping it from memory — each is short and already structured for the renderer (headings for TOC, fenced code blocks with a language tag, mermaid where it fits). Read the template, replace every `{{TOKEN}}` placeholder, delete sections that don't apply, and pass the result as `content` to `add_artifact` (or `update_artifact`).

| Template | Use for |
| --- | --- |
| `templates/phased-plan.md` | Multi-phase work with tasks, acceptance criteria, and open questions |
| `templates/design-doc.md` | A decision with options considered, trade-offs, and consequences (ADR-style) |
| `templates/status-report.md` | A point-in-time update: shipped, in flight, blocked, next |
| `templates/diagram-doc.md` | A document that's primarily a mermaid diagram (architecture, sequence, flow) with light scaffolding |

None of these are mandatory — write plain markdown when a document doesn't fit any of them. They exist to save the boilerplate of getting headings and mermaid fences right for a document type that recurs often.

### Step 5: Share the link

`add_artifact` and `update_artifact` both return the artifact's `id` and its resolved `url`. Hand the `url` to the user directly rather than the id alone — that's the whole point of the round trip.

## Important Behaviors

- **Markdown content is replaced wholesale on update** — there is no partial-edit or patch operation. Always send the complete document.
- **Mermaid fences render client-side** — a ```` ```mermaid ```` fenced block is enough; no extra setup.
- **Code blocks should declare a language** (` ```ts `, ` ```bash `, etc.) so they get syntax highlighting instead of a plain-text fallback.
- **The TOC only appears once a document has two or more headings** — a single-heading document (or one relying only on prose) won't get one, which is fine for short documents but worth knowing if you expect a nav.
- **Don't invent a new `project` string per artifact.** Reusing the same one is what makes Step 1's `list_artifacts` filter useful later, for you or another agent.

## Setup (operator step, not agent-facing)

This skill assumes:

1. The Artifacts MCP server is registered: `claude mcp add --transport http artifacts https://artifacts.valhalla.local/mcp --scope user` (adjust the host to your deployment).
2. This skill directory is symlinked into the skills path Claude reads, e.g.: `ln -s <repo>/skills/artifact ~/.claude/skills/artifact`.

Neither step is something the agent does mid-task — both are one-time environment setup performed by the person operating the agent.
