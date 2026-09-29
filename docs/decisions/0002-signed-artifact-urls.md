---
type: adr
title: ADR-0002 - Short-lived signed URLs read one artifact without a session
description: With owner auth on, a URL signed by the server reads one artifact for 60 seconds without a session. The thumbnail renderer gets a fresh one for every render.
status: accepted
created: 2026-09-29
modified: 2026-09-29
---
# ADR-0002 - Short-lived signed URLs read one artifact without a session

## Context

[ADR-0001](0001-opt-in-owner-auth.md) requires a session for every artifact when owner auth is on.
The headless thumbnail renderer has no session, so with auth on it would capture the login form.
Sandboxed HTML artifacts have the same problem when they embed other artifacts, because the browser
does not send the session cookie on their subresource requests.

## Decision

- **Signed URLs are the one exception to the session rule.** `/a/:id?expires=…&signature=…` reads
  that one artifact with `GET` or `HEAD` until `expires`, in Unix seconds. The signature is an
  HMAC-SHA-256 over a fixed purpose label, the artifact ID, and the expiry. It grants nothing on any
  other path, artifact, or method.
- **A signature is judged, not redirected.** A session still lets the owner through. Without one, a
  request that carries a `signature` parameter gets `403` unless the signature is valid for it,
  because its reader is a renderer or an embed, not a person who can log in.
- **The key is random per process.** It is generated at startup and never stored. It is not derived
  from the owner password, so a leaked URL gives no offline way to test password guesses. A restart
  voids every outstanding URL, which costs nothing while URLs last seconds.
- **Thumbnails sign per render.** The queue asks for the path when a render starts, not when the
  artifact is queued, and a URL lasts 60 seconds against the renderer's 15-second cap.

The signer (`src/auth/signed-urls.ts`) knows nothing about HTTP, so embedded-artifact URLs can
reuse it.

## Considered options

- **Hand the renderer a session.** A long-lived credential in a browser that loads untrusted
  documents could be used for every artifact, not the one being rendered.
- **Derive the key from the password.** It survives restarts, but every issued URL becomes material
  for offline password guessing.

## Consequences

- A deployment that runs more than one process, or serves embed URLs across restarts, needs a
  shared key. That key must come from its own secret, not the password.
