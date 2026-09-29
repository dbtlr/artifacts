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
  path. Text inside `script`, `style`, comments, and other raw-text elements is skipped. Markup
  inside `noscript` counts, because the thumbnail renderer runs without scripts and then loads it.
  URLs that scripts build, CSS `url()`, and links are not signed.
- **A template keeps at most 1,000 references.** Later references stay unsigned. The cap bounds
  the signing work of each view, which runs on every request for the page, and the size of the
  stored template. A view signs each distinct artifact once, however often the page names it.
- **Each view signs every reference again.** With auth on, a view replaces each recorded `/a/<id>`
  with a signed path to that artifact and keeps the author's host and fragment. The view does no
  HTML parsing. With auth off, the page is served unchanged.
- **Embed URLs last 10 to 15 minutes.** A lazy image or frame loads when the reader scrolls to it,
  well after the page arrived. The expiry is rounded up to a five-minute boundary at least 10
  minutes after the end of the current clock five minutes, so every view in the same five minutes
  gets the same URLs and the browser can reuse what it cached. Five minutes divides an hour, so
  those views also share one [hourly signing key](0004-hourly-url-signing-keys.md). Thumbnail URLs
  keep their 60 seconds. Both use the same signer.
- **A signed page signs its own embeds.** A request that reaches an HTML artifact, by session or by
  signature, gets that artifact's embeds signed. This lets a framed HTML artifact and a gallery
  preview show their images.
- **The template is derived data.** It stores positions only, not a copy of the page. A failure to
  store it does not fail the create. A missing or unreadable template, or one from another extractor
  version, is extracted and stored on the next view.

## Considered options

- **Find references on every view.** It needs no storage, but it parses the whole page on every
  request, which the Cloudflare target's CPU limit makes costly.
- **Store the rewritten page.** A view would read one row instead of the content and the template.
  It doubles storage and can exceed a row size limit for large pages.
- **Parse with an HTML parser library.** It matches browsers more exactly. A mismatch in the
  hand-written scanner only leaves an embed unsigned or signs a URL that the artifact's author
  named, so a new dependency buys little.

## Consequences

- An HTML artifact's own scripts can read the signed URLs in the page and send them elsewhere,
  because the sandbox does not limit where a page sends requests. Artifacts are immutable, so the
  references are fixed when the artifact is created. For the API key holder who created it, that
  grants nothing new: the key already reads every artifact.
- It does grant something to anyone who controls part of an HTML artifact's text without holding a
  key, such as a third party whose markup an agent copies into an artifact. If that party also
  knows another artifact's ID, for example from a shared link, the page can name it and send its
  signed URL to them when the owner views the page. Without signed embeds, a known ID gave no read
  access without a session. This risk is accepted: it needs both injected markup and a known ID,
  and each signed URL expires after at most 15 minutes. An agent that publishes HTML from an
  untrusted source can expose any artifact that the HTML names.
- A signed URL copied from a page reads that one artifact for up to 15 minutes.
- Embeds that the extractor does not find, such as script-built URLs or CSS `url()`, still fail
  with auth on.

## Changelog

- 2026-09-29: Embed URLs round their expiry up to a five-minute boundary, so views in the same
  five minutes share URLs and the browser cache. They last 10 to 15 minutes instead of exactly 10.
