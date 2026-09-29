---
type: adr
title: ADR-0006 - HTML artifacts run in an opaque-origin sandbox that allows scripts, popups, and dialogs
description: HTML artifacts are served with a CSP sandbox that keeps them out of the app's origin but lets them run scripts, open new windows, and show dialogs.
status: accepted
created: 2026-09-29
modified: 2026-09-29
---
# ADR-0006 - HTML artifacts run in an opaque-origin sandbox that allows scripts, popups, and dialogs

## Context

HTML artifacts are pages that the owner's agents write, such as UI mocks and reports. They can
include third-party content, such as scripts from a CDN or markup that an agent copied, and that
content can be compromised. The app serves them from its own origin, next to its session cookie,
its routes, and `/mcp`.

HTML artifacts were first served with `Content-Security-Policy: sandbox allow-scripts`. That
isolated them from the app, but it also stopped `target="_blank"` links, `window.open()`, and
`alert()` and `confirm()` dialogs. Agent-made mocks use these, and the browser blocked them without
an error the author could see.

## Decision

- **One header, in both auth modes.** A GET or HEAD for an HTML artifact returns exactly
  `Content-Security-Policy: sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-modals`,
  whether an owner password is set or not.
- **Scripts run.** `allow-scripts` is set, because interactive pages are the reason to publish HTML.
- **No `allow-same-origin`.** The page runs in an opaque origin. Its scripts cannot read the app's
  cookies, storage, or responses, and its requests carry `Origin: null`, which `/mcp` refuses.
- **No `allow-forms`.** A form in an artifact cannot submit to the app.
- **New windows open as ordinary pages.** `allow-popups` lets `target="_blank"` links and
  `window.open()` open a new window. `allow-popups-to-escape-sandbox` loads that window without the
  artifact's sandbox, so a linked site works as it does when the reader opens it directly.
- **Dialogs work.** `allow-modals` lets the page call `alert()`, `confirm()`, `prompt()`, and
  `print()`.
- **No other sandbox flags.** Downloads, top-level navigation from a frame, pointer lock, and the
  other flags stay off.

## Considered options

- **Keep only `allow-scripts`.** It is the smallest grant, but it breaks common mock behavior with
  no visible error.
- **Allow popups without `allow-popups-to-escape-sandbox`.** The new window inherits the sandbox:
  it runs in an opaque origin without cookies or storage, so sign-ins and many sites fail in it.
- **Add `allow-same-origin` so storage works.** It gives artifact scripts the app's origin, with
  the session cookie and `/mcp`. Rejected.

## Consequences

- Compromised content in an artifact can open windows and show dialogs. It can already navigate its
  own page to any URL, so this adds nuisance, not access.
- A window that an artifact opens is not sandboxed. If it shows this server, it is an ordinary
  top-level page with the reader's session, the same as a link the reader follows. The artifact
  cannot read that page, because the two have different origins.
- HTML artifacts still cannot use `localStorage`, `sessionStorage`, IndexedDB, or cookies, submit
  forms, or read responses from this server. CORS loads from this server, such as
  `<script type="module">`, fail. An embedded PDF does not display.
