---
name: artifact
description: Share documents, images, and PDFs with a human as persistent links via the Artifacts MCP server. Use when the user asks to publish or share an artifact, document, diagram, generated image, or PDF with a link.
---

# Artifact — Share Documents and Files via Persistent Links

Publish a document or file to the Artifacts server and hand back the returned URL. Artifacts are immutable: once published, an artifact never changes. A revision or variation is a new artifact in the same collection, so every earlier version keeps its own working link.

## Why This Skill Exists

Documents produced mid-task — a plan, a design doc, a status update, a diagram — are easiest to review as a rendered page with a link, especially when working with the user remotely. Artifacts gives every such document a stable URL; this skill teaches the decisions an agent has to make before writing one: which collection it belongs to, and which template and metadata to use.

## Core Workflow

### Step 1: Look for an existing artifact or collection first

Before creating anything, call `list_collections` and `list_artifacts` (pass `project` if you know it) to find earlier versions of the same document or file.

- **A revision is a new artifact.** There is no update. To revise a plan, status report, or design doc, publish the full new version with `add_artifact` and give it the same `collection` as the earlier versions. Share the new link; the old links keep showing the old versions.
- **Start from the latest version when editing.** Call `get_artifact` with `includeContent: true` on the newest artifact in the collection, edit the result, and publish the complete document as a new artifact.
- **Offer variations side by side.** When the user should choose between alternatives, publish one artifact per variation in one collection.
- **Do not republish unchanged content.** If an existing artifact already says what the user needs, share its link.

### Step 2: Choose metadata

- **title** — short and human-scannable; it's what shows up in list views. ("Q3 Migration Plan", not "Plan for migrating the thing we discussed.")
- **project** — a stable string per repo or initiative, reused across every artifact in that body of work (matches what `list_artifacts` filters on in Step 1). Pick it once and keep it consistent so Step 1 keeps finding the right artifacts.
- **description** — one line, written for the list view, not the document body.
- **collection** — shared metadata for related independent artifacts. Set one on any document that may be revised later, because an artifact cannot be moved into a collection after it is published. Reuse one value for a document, its revisions, and its images so another agent can rediscover the set. A collection does not own its members.

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

Reference the template file directly rather than retyping it from memory — each is short and already structured for the renderer (headings for TOC, fenced code blocks with a language tag, mermaid where it fits). Read the template, replace every `{{TOKEN}}` placeholder, delete sections that don't apply, and pass the result as `content` to `add_artifact`.

| Template | Use for |
| --- | --- |
| `templates/phased-plan.md` | Multi-phase work with tasks, acceptance criteria, and open questions |
| `templates/design-doc.md` | A decision with options considered, trade-offs, and consequences (ADR-style) |
| `templates/status-report.md` | A point-in-time update: shipped, in flight, blocked, next |
| `templates/diagram-doc.md` | A document that's primarily a mermaid diagram (architecture, sequence, flow) with light scaffolding |

None of these are mandatory — write plain markdown when a document doesn't fit any of them. They exist to save the boilerplate of getting headings and mermaid fences right for a document type that recurs often.

### Step 5: For embeds, create the file first

Create each image or PDF before the containing document, then use the absolute `url` returned by
`add_artifact`. Do not reconstruct the hostname.

```html
<img src="https://artifacts.example/a/returned-id" alt="Descriptive alternative text">
```

```md
![Descriptive alternative text](https://artifacts.example/a/returned-id)
```

Give the file and document the same collection for rediscovery. Files remain independent artifacts:
deleting an embedded file breaks the embed, and deleting the document does not delete its files.
To replace an embedded image, add the new image, then publish a new version of the document that
embeds the new URL. The earlier document keeps showing the earlier image.

### Step 6: Share the link

`add_artifact` returns the artifact's `id` and resolved `url`. Hand the `url` to the user directly rather than the id alone.

## Important Behaviors

- **Artifacts cannot be edited.** There is no update or patch operation. Every version is a complete document published with `add_artifact`.
- **Mermaid fences render client-side** — a ```` ```mermaid ```` fenced block is enough; no extra setup.
- **Code blocks should declare a language** (` ```ts `, ` ```bash `, etc.) so they get syntax highlighting instead of a plain-text fallback.
- **The TOC only appears once a document has two or more headings** — a single-heading document (or one relying only on prose) won't get one, which is fine for short documents but worth knowing if you expect a nav.
- **Don't invent a new `project` string per artifact.** Reusing the same one is what makes Step 1's `list_artifacts` filter useful later, for you or another agent.
- **Discovery is metadata-only by default.** `add_artifact`, `list_artifacts`, and ordinary `get_artifact` do not echo binary base64. Pass `includeContent: true` only for explicit retrieval; binary content is returned as `contentBase64` and text as `content`.
- **An oversized request may fail before the tool runs.** The HTTP request-body guard can reject base64 plus JSON overhead before an MCP error result is produced.

## Setup (operator step, not agent-facing)

This skill assumes:

1. The Artifacts MCP server is registered in the agent client using the deployment's `/mcp` URL.
2. This skill directory is installed in the client-specific personal skills directory.

Neither step is something the agent does mid-task — both are one-time environment setup performed by the person operating the agent.
