---
type: adr
title: ADR-0001 - Opt-in owner auth revises the no-auth boundary
description: Setting ARTIFACTS_OWNER_PASSWORD turns on a single-owner password login with database sessions. Without it, Artifacts has no authentication and stays a trusted-network tool.
status: accepted
created: 2026-09-29
modified: 2026-09-29
---
# ADR-0001 - Opt-in owner auth revises the no-auth boundary

## Context

Artifacts had no authentication. Its documented boundary was loopback or a trusted network, with an
authentication-capable reverse proxy for anything wider. That boundary cannot hold for a hosted
deployment target that has no trusted network. It also makes a home operator run a separate proxy
to reach an instance from outside the network.

An open instance is also a free file host: anyone who can reach it can publish pages, including
phishing pages, on the owner's domain. So when auth is on, nothing is readable without the owner's
credentials. Links serve the owner only, and sharing with other people is not supported.

## Decision

- **One owner, one password.** The password comes from the `ARTIFACTS_OWNER_PASSWORD` secret. There
  are no user, role, or tenant tables.
- **Opt-in on Node.** When the variable is unset, the app has no login, no session, and no auth
  routes, and it behaves exactly as before. A blank value is a startup error, so a half-written
  secret cannot leave an instance open.
- **Database sessions.** A login creates a row in `owner_sessions`, keyed by an HMAC-SHA-256 of a
  256-bit random token with the password as the key, so a new password ends every session. The
  token goes in an `HttpOnly`, `SameSite=Lax` cookie, which is also `Secure` when the public base
  URL is HTTPS. A session lasts 7 days from login, and logout deletes it.
- **Every page and artifact needs a session.** This covers every UI route and `/a/:id`. Only the
  login form, `/assets/*`, and the root icons are public. Responses to a session are marked
  `Cache-Control: private`.
- **Rate-limited login.** At most 10 attempts, right or wrong, in any 15-minute window, counted in
  the database. The limit is global, not per client, because behind a proxy every client has the
  proxy's address. An attacker can keep the owner locked out. That is the accepted cost of a hard
  cap on guesses.
- **Origin-checked forms.** Nothing changes state on GET. A POST with a missing, foreign, or `null`
  Origin is refused. Together with `SameSite=Lax`, this blocks cross-site form submission and
  requests from sandboxed HTML artifacts.
- **`/mcp` takes API keys, not sessions,** because an MCP client cannot hold a session cookie. The
  owner creates and revokes keys on a server-rendered page. A new key, `art_` and 256 random bits,
  is shown once and stored in `api_keys` only as its SHA-256 hash. A request to `/mcp` must carry
  `Authorization: Bearer <key>`. The hash is not keyed by the password, so a new password keeps
  agents connected. Keys do not expire, and revoking one deletes its row.

Passkeys can later use the same session model.

## Considered options

- **Keep no-auth and require a proxy.** This does not work on a platform without a trusted network,
  and it keeps the free-hosting abuse path open.
- **An identity-aware proxy from the hosting platform.** It exists on only one platform, and
  exempting `/mcp` would need a separate hostname.
- **Unlisted capability links.** Rejected as an abuse vector: holding a link would be enough to read
  what it points to, and links leak.
- **Per-client rate limiting.** Client addresses are unreliable behind proxies, and a per-address
  limit lets a distributed attacker guess without a bound.

## Consequences

- Artifacts now owns security-sensitive code: password checks, sessions, API keys, CSRF defense,
  and rate limiting.
- With auth on, gallery previews stay as placeholders, because the headless renderer has no
  session and would capture the login form.
- With auth on, an HTML artifact cannot load other artifacts by URL. Its sandbox gives it an opaque
  origin, so the browser does not send the `SameSite=Lax` cookie on its subresource requests.
