---
type: adr
title: ADR-0003 - HTML artifacts load embedded artifacts through URLs signed at view time
description: An HTML artifact's /a/:id references are found once when it is stored, and with owner auth on each view replaces them with fresh signed URLs.
status: accepted
created: 2026-09-29
modified: 2026-09-29
---
# ADR-0003 - HTML artifacts load embedded artifacts through URLs signed at view time

## Context

HTML artifacts run in an opaque-origin CSP sandbox, so the browser does not send the session cookie
on their subresource requests. With owner auth on, an image such as `<img src="/a/<id>">` in an HTML
artifact therefore got the login redirect instead of the image. [ADR-0002](0002-signed-artifact-urls.md)
added signed URLs that read one artifact without a session. Artifacts are immutable, so anything
derived from an artifact's content can be computed once and kept.

## Decision

- **References are found once, when the artifact is stored.** Creating an HTML artifact scans its
  text the way a browser splits it into tags and records where each reference to this instance
  starts. The result, the embed template, is a row in `artifact_embed_templates`. Its foreign key
  drops it with the artifact.
- **Only loading attributes count.** A reference is `/a/<id>` from the site root, or under
  `ARTIFACTS_PUBLIC_BASE_URL`, in the `src`, `srcset`, `poster`, or `href` of `img`, `source`,
  `iframe`, `video`, `audio`, and `link`. It may end with a fragment, but not a query or a further
  path. Text inside `script`, `style`, comments, and other raw-text elements is skipped. URLs that
  scripts build, CSS `url()`, and links are not signed.
- **Each view signs every reference again.** With auth on, a view replaces each recorded `/a/<id>`
  with a signed path to that artifact and keeps the author's host and fragment. The view does no
  HTML parsing. With auth off, the page is served unchanged.
- **Embed URLs last 10 minutes.** A lazy image or frame loads when the reader scrolls to it, well
  after the page arrived. Thumbnail URLs keep their 60 seconds. Both use the same signer and key.
- **A signed page signs its own embeds.** A request that reaches an HTML artifact, by session or by
  signature, gets that artifact's embeds signed. This lets a framed HTML artifact and a gallery
  preview show their images.
- **The template is derived data.** It stores positions only, not a copy of the page. A failure to
  store it does not fail the create. A missing template, or one from another extractor version, is
  extracted and stored on the next view.

## Considered options

- **Find references on every view.** It needs no storage, but it parses the whole page on every
  request, which the Cloudflare target's CPU limit makes costly.
- **Store the rewritten page.** A view would read one row instead of the content and the template.
  It doubles storage and can exceed a row size limit for large pages.
- **Parse with an HTML parser library.** It matches browsers more exactly. A mismatch in the
  hand-written scanner only leaves an embed unsigned or signs a URL that the artifact's author
  named, so a new dependency buys little.

## Consequences

- An HTML artifact's own scripts can read the signed URLs in the page and send them elsewhere. That
  grants nothing new. Artifacts are immutable and IDs are random, so the references are fixed when
  the artifact is created and can name only artifacts that existed then. Whoever created it could
  already read those: through an API key with auth on, or without one with auth off.
- A signed URL copied from a page reads that one artifact for up to 10 minutes.
- Embeds that the extractor does not find, such as script-built URLs or CSS `url()`, still fail
  with auth on.
