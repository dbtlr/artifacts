# Security Policy

## Supported versions

Artifacts is unversioned pre-alpha software. There are no supported releases and no guarantee that
security fixes will be backported.

## Deployment boundary

Artifacts has two modes. `ARTIFACTS_OWNER_PASSWORD` selects between them.

### Without an owner password

This is the default. Artifacts has no authentication or authorization. Anyone who can reach the
server can list, read, create, and remove artifacts. Deploy it only on loopback or a trusted
internal network. If broader access is required, set an owner password or place an
authentication-capable reverse proxy in front of it, and verify that the application itself is not
directly reachable.

`/mcp` refuses a request whose Origin header names another origin, or is `null`. This keeps web
pages and HTML artifacts from creating or removing artifacts through a visitor's browser.
Command-line and desktop MCP clients send no Origin header, so they work. A browser-based MCP
client sends the origin of its own page, so `/mcp` refuses it. For example, MCP Inspector in
direct connection mode cannot connect. The same rule applies with an owner password.

### With an owner password

Every page and every `/a/:id` link requires a session from the login form. Only the login form,
`/assets/*`, and the root icons are public. There is one owner and no other accounts, so links work
only for the owner.

- Sessions are stored in the database as keyed hashes of random tokens and last 7 days. A new
  password ends every session. The cookie is `HttpOnly` and `SameSite=Lax`. It is `Secure` when
  `ARTIFACTS_PUBLIC_BASE_URL` uses HTTPS.
- The server refuses to start when the password is shorter than 16 characters.
- Login allows 10 attempts from one client address in any 15-minute window, and 100 from all
  addresses together. The total limit bounds guesses to fewer than 10,000 a day. An attacker who
  controls enough addresses to reach it can keep the owner locked out.
- The client address is the connection's address, unless the operator names a header in
  `ARTIFACTS_CLIENT_ADDRESS_HEADER`, such as `CF-Connecting-IP`. The server reads only that header,
  and for a list it takes the last entry. A client that reaches the server without passing through
  the proxy can set the header to any address, and so can escape the per-address limit, but not the
  total limit. Name a header only when the proxy always sets it and the server is reachable only
  through the proxy. Without a named header, all clients behind a proxy share one address.
- A POST with a missing, foreign, or `null` Origin header is refused, except to `/mcp`. `/mcp`
  follows the Origin rule above: a request with no Origin and a valid API key is accepted.
- Pages other than `/a/:id` are sent with `X-Frame-Options: DENY` and
  `Content-Security-Policy: frame-ancestors 'none'`, so no other page can frame the login, key, or
  gallery pages. Artifacts stay frameable, because HTML artifacts embed them.
- `/mcp` requires `Authorization: Bearer <key>` with an API key. The owner creates and revokes keys
  on the `/keys` page. A new key is shown once and stored only as a SHA-256 hash. Keys do not
  expire, and a new password does not revoke them. The page shows when each key was created and
  last used. After a password leak, change the password, use **Revoke all keys**, and create new
  keys for your agents.
- The thumbnail renderer reads artifacts through signed URLs. Each one allows `GET` or `HEAD` of one
  `/a/:id` for 60 seconds. It is an HMAC-SHA-256 over the artifact ID and the expiry. The key is
  random, there is a new one for each clock hour, and it is stored in the database. A URL verifies
  only with the current or previous hour's key, so no signed URL works for more than about two
  hours. A request with an expired, altered, or misapplied signature and no session gets `403`.
- An HTML artifact's embedded `/a/:id` URLs get the same kind of signature on each view, valid for
  10 to 15 minutes. Views in the same clock five minutes get the same URLs, so the browser can reuse
  cached embeds. A page read through a signature also gets its embeds signed. The artifact's own
  scripts can read these URLs. The references are fixed when the artifact is created, so they name
  only artifacts that its creator could already read.

Serve the instance over HTTPS when it is reachable beyond loopback. Over plain HTTP, the password and
the session cookie cross the network in clear text. Use a long, random password.

In both modes, HTML artifacts run in an opaque-origin CSP sandbox. Never store secrets in artifacts.

## Reporting a vulnerability

Email [hi@dbtlr.com](mailto:hi@dbtlr.com). Include affected behavior, reproduction steps, impact,
and any suggested mitigation. Do not open a public issue for an unresolved vulnerability.

Because the project is pre-alpha, response and remediation timelines are best effort.
