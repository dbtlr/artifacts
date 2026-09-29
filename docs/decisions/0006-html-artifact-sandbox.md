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
  other flags stay off for the artifact's own page. They do not apply to a window it opens.

## Considered options

- **Keep only `allow-scripts`.** It is the smallest grant, but it breaks common mock behavior with
  no visible error.
- **Allow popups without `allow-popups-to-escape-sandbox`.** The new window inherits the sandbox:
  it runs in an opaque origin without cookies or storage, so sign-ins and many sites fail in it.
- **Add `allow-same-origin` so storage works.** It gives artifact scripts the app's origin, with
  the session cookie and `/mcp`. Rejected.

## Consequences

- Compromised content in an artifact can open windows and show dialogs. A `prompt()` dialog shows
  this server's host name and can ask for a password, but the same script can already draw a fake
  sign-in form in the page and send what the reader types to another site. It can also navigate its
  own page to any URL. So this adds nuisance, not access.
- A window that an artifact opens is not sandboxed. It is an ordinary top-level page, the same as a
  link the reader follows, so it can start downloads. If it shows this server, it has the reader's
  session. The artifact cannot read that page, because the two have different origins.
- A page opened with `window.open()`, unless the call passes `noopener`, keeps a `window.opener`
  handle and can navigate the artifact's tab to another URL, such as a phishing page. It cannot
  read the artifact, because the two have different origins. Browsers open `target="_blank"` links
  with `noopener` by default.
- `allow-popups` also lets the page follow links with other schemes, such as `mailto:`, which the
  browser hands to an app registered for that scheme. The browser can ask the reader before it
  opens the app.
- HTML artifacts still cannot use `localStorage`, `sessionStorage`, IndexedDB, or cookies, submit
  forms, or read responses from this server. CORS loads from this server, such as
  `<script type="module">`, fail. An embedded PDF does not display.
