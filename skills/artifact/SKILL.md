---
name: artifact
description: Share documents, images, and PDFs with a human as persistent links via the Artifacts MCP server. Use when the user asks to publish or share an artifact, document, diagram, generated image, or PDF with a link.
---

# Artifact — Share Documents and Files via Persistent Links

Publish a document or file to the Artifacts server and hand back the returned URL. The same URL keeps working across edits, so living artifacts should be updated in place rather than re-created.

## Why This Skill Exists

Documents produced mid-task — a plan, a design doc, a status update, a diagram — are easiest to review as a rendered page with a link, especially when working with the user remotely. Artifacts gives every such document a stable URL; this skill teaches the decision an agent has to make before writing one: update the existing artifact, or create a new one, and with which template and metadata.

## Core Workflow

### Step 1: Look for an existing artifact or collection first

Before creating anything, call `list_artifacts` (pass `project` if you know it) to check whether it already exists. For a multi-artifact result such as a document with generated images, call `list_collections` and filter `list_artifacts` by the chosen collection.

- **Update beats duplicate for living documents.** A plan, status report, or design doc that's still evolving should be updated via `update_artifact`, not recreated — the URL stays the same across updates, so anyone holding the old link keeps seeing current content.
- **Create only when genuinely new** — a document that hasn't existed before, or a distinct artifact from ones already listed (a new phase's plan is not the same artifact as the previous phase's).
- When updating, content is a full replacement, not a diff. If you're editing rather than regenerating, call `get_artifact` with `includeContent: true`, edit the result, then send the full replacement to `update_artifact`.

### Step 2: Choose metadata

- **title** — short and human-scannable; it's what shows up in list views. ("Q3 Migration Plan", not "Plan for migrating the thing we discussed.")
- **project** — a stable string per repo or initiative, reused across every artifact in that body of work (matches what `list_artifacts` filters on in Step 1). Pick it once and keep it consistent so Step 1 keeps finding the right artifacts.
- **description** — one line, written for the list view, not the document body.
- **collection** — optional shared metadata for related independent artifacts. Reuse one value for a document and its images so another agent can rediscover the set. A collection does not own its members.

### Step 3: Choose a media type and payload

- **`text/markdown`** (document default) — plans, design docs, reports, diagrams, and notes. Send UTF-8 text as `content`.
- **`text/html`** — bespoke layouts that Markdown cannot express. HTML is served as-is. Send it as `content`.
- **`text/plain`** — logs and raw output. Send it as `content`.
- **PNG, JPEG, GIF, WebP, SVG, or PDF** — use canonical `mediaType`, a safe `filename` whose extension agrees with it, and canonical base64 in `contentBase64`. The decoded limit is 10 MiB; binary files must not be empty and their signatures are validated.

Current guidance uses `mediaType`. The legacy `type` field exists only for text-client compatibility.
Never put binary bytes in `content`. If a shell fallback is unavoidable, base64-encode the file bytes
explicitly; do not read them as text. Base64 consumes agent context, so resize or compress generated
images before upload and request binary content only when it is needed.

### Step 4: For documents, pick a template and write it

Reference the template file directly rather than retyping it from memory — each is short and already structured for the renderer (headings for TOC, fenced code blocks with a language tag, mermaid where it fits). Read the template, replace every `{{TOKEN}}` placeholder, delete sections that don't apply, and pass the result as `content` to `add_artifact` (or `update_artifact`).

| Template | Use for |
| --- | --- |
| `templates/phased-plan.md` | Multi-phase work with tasks, acceptance criteria, and open questions |
| `templates/design-doc.md` | A decision with options considered, trade-offs, and consequences (ADR-style) |
| `templates/status-report.md` | A point-in-time update: shipped, in flight, blocked, next |
| `templates/diagram-doc.md` | A document that's primarily a mermaid diagram (architecture, sequence, flow) with light scaffolding |

None of these are mandatory — write plain markdown when a document doesn't fit any of them. They exist to save the boilerplate of getting headings and mermaid fences right for a document type that recurs often.

### Step 5: For embeds, create the file first

Create each image or PDF before the containing document, then use the absolute `url` returned by
`add_artifact` or `update_artifact`. Do not reconstruct the hostname.

```html
<img src="https://artifacts.example/a/returned-id" alt="Descriptive alternative text">
```

```md
![Descriptive alternative text](https://artifacts.example/a/returned-id)
```

Give the file and document the same collection for rediscovery. Files remain independent artifacts:
deleting an embedded file breaks the embed, and deleting the document does not delete its files.

### Step 6: Share the link

`add_artifact` and `update_artifact` both return the artifact's `id` and resolved `url`. Hand the `url` to the user directly rather than the id alone.

## Important Behaviors

- **Markdown content is replaced wholesale on update** — there is no partial-edit or patch operation. Always send the complete document.
- **Mermaid fences render client-side** — a ```` ```mermaid ```` fenced block is enough; no extra setup.
- **Code blocks should declare a language** (` ```ts `, ` ```bash `, etc.) so they get syntax highlighting instead of a plain-text fallback.
- **The TOC only appears once a document has two or more headings** — a single-heading document (or one relying only on prose) won't get one, which is fine for short documents but worth knowing if you expect a nav.
- **Don't invent a new `project` string per artifact.** Reusing the same one is what makes Step 1's `list_artifacts` filter useful later, for you or another agent.
- **Discovery is metadata-only by default.** `add_artifact`, `update_artifact`, `list_artifacts`, and ordinary `get_artifact` do not echo binary base64. Pass `includeContent: true` only for explicit retrieval; binary content is returned as `contentBase64` and text as `content`.
- **An oversized request may fail before the tool runs.** The HTTP request-body guard can reject base64 plus JSON overhead before an MCP error result is produced.

## Setup (operator step, not agent-facing)

This skill assumes:

1. The Artifacts MCP server is registered in the agent client using the deployment's `/mcp` URL.
2. This skill directory is installed in the client-specific personal skills directory.

Neither step is something the agent does mid-task — both are one-time environment setup performed by the person operating the agent.
