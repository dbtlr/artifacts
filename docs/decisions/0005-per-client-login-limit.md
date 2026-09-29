---
type: adr
title: ADR-0005 - Login attempts are limited per client address, under a total ceiling
description: With owner auth on, failed logins are counted per client address, read from a proxy header only when the operator names one, with a higher total limit as a backstop; a password shorter than 16 characters stops startup.
status: accepted
created: 2026-09-29
modified: 2026-09-29
---
# ADR-0005 - Login attempts are limited per client address, under a total ceiling

## Context

[ADR-0001](0001-opt-in-owner-auth.md) limited logins to 10 attempts in any 15-minute window for the
whole instance. It rejected a per-client limit because behind a proxy every client has the proxy's
address, and because a per-address limit alone lets a distributed attacker guess without a bound.
The single count had its own cost: anyone who can reach `/login` can keep the owner locked out with
10 requests every 15 minutes. That cost matters most for an instance exposed to the internet, which
is what an owner password is for. The server also accepted a password of any length, so the rate
limit was the only thing between a short password and a guess.

## Decision

- **Two counts, one reservation.** An attempt, right or wrong, is recorded against its client
  address only when that address has fewer than 10 attempts in the window and all addresses
  together have fewer than 100. The check and the insert are one SQL statement, so parallel
  attempts cannot slip past either limit. The window stays 15 minutes.
- **A success clears its own address only.** The owner's login does not reset the counts of other
  addresses.
- **The operator names the client address header.** `ARTIFACTS_CLIENT_ADDRESS_HEADER` names the
  header that a trusted proxy sets, such as `CF-Connecting-IP` on Cloudflare. For a list header
  such as `X-Forwarded-For`, the last entry counts, because the nearest proxy appends it. No other
  header is ever read, because any client can send one. Without the setting, or when a request lacks
  the named header, the address is the connection's peer address on Node. When neither is known,
  all such attempts share one count.
- **The variable is read only with auth on.** Without an owner password it has no effect, so
  no-auth mode is unchanged.
- **A short password stops startup.** A password shorter than 16 characters, counted as a reader
  sees them (Unicode grapheme clusters), is a startup error, like a blank one. The Docker helper
  applies the same rule before it replaces a container.

## Considered options

- **Keep the single count.** It bounds guesses to about 1,000 a day, but any visitor can lock the
  owner out.
- **Per-address limit only.** It leaves guesses unbounded for an attacker with many addresses. The
  total limit keeps a bound, and the password minimum makes that bound safe.
- **Trust a fixed header, such as `X-Forwarded-For`.** A client that reaches the server directly
  could choose its own address for every attempt. Only the operator knows which header the proxy
  sets.
- **Group IPv6 addresses by prefix.** An attacker with a /64 has many addresses, but the total limit
  already bounds what many addresses can do. It can be added later without a schema change.

## Consequences

- Guesses from all addresses are bounded to fewer than 10,000 a day. Against a random 16-character
  password, that is no practical chance.
- An attacker with 10 or more addresses can still reach the total limit and keep the owner locked
  out. One address can no longer do so.
- With a header named, a client that bypasses the proxy can set any address and escape the
  per-address limit, but not the total limit. The server must be reachable only through the proxy.
- Behind a proxy with no header named, every client shares the proxy's address, so the per-address
  limit acts like the old single count.
- An existing instance with a password shorter than 16 characters stops at startup until the
  password is replaced. A new password ends every session, as before.
