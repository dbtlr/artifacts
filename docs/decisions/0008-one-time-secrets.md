---
type: adr
title: ADR-0008 - One-time secrets travel through single-use URLs, never through MCP
description: Muninn stores one-time secrets as a separate kind of entity, encrypted with a key it never stores. MCP tools return single-use URLs and handles, never secret contents, and a view link alone is enough to read a secret once.
status: accepted
created: 2026-10-26
modified: 2026-10-26
---
# ADR-0008 - One-time secrets travel through single-use URLs, never through MCP

## Context

The owner and their agents need to hand each other secrets, such as tokens, passwords, and key
files, across remote sessions. The agent should move the secret without seeing it. Every MCP tool
argument and tool result enters the agent's transcript and reaches the model provider, so a tool
that accepts or returns a secret cannot meet that need.

[ADR-0001](0001-opt-in-owner-auth.md) rejected unlisted capability links for artifacts, because
links leak and anyone holding one could read what it points to. A one-time secret has to reach a
person on whatever device they have at hand, often without a session.

## Decision

- **Secrets are not artifacts.** They have their own tables, routes under `/s/`, and MCP tools.
  They never appear in the gallery, collections, thumbnails, `list_artifacts`, or any listing.
  [ADR-0004](0004-hourly-url-signing-keys.md)'s signed URLs and the workspace's immutable-artifact
  rule do not apply to them.
- **Contents never cross MCP.** No tool accepts or returns secret bytes. Tools return single-use
  URLs, handles, and status. The agent moves the bytes with a shell pipe into or out of `curl`.
- **A secret exists only once its contents arrive.** `create_secret_upload` returns an upload URL
  that is not a secret and has no page. A successful upload creates the secret and returns its view
  link. An unused upload URL expires after 15 minutes.
- **Encrypted with a key Muninn does not keep.** Each secret gets a fresh 256-bit AES-GCM key, with
  the secret's id as additional authenticated data. Only the ciphertext is stored. The key lives in
  the view link's fragment, in the owner's handle, or wrapped under a claim token, never unwrapped
  in the database. URL tokens are stored only as SHA-256 hashes.
- **Reading burns it.** A read deletes the contents. A wrong key does not burn the secret, and two
  concurrent reads cannot both succeed. A failed read is not retried; the sender makes a new one.
  Unread secrets expire after 24 hours by default, between 1 hour and 7 days.
- **The view link alone reads a secret, even with owner auth on.** `/s/:id#<key>` and its Reveal
  `POST` need no session. This is a deliberate exception to ADR-0001's rejection of capability
  links: only an API key or the owner's session can create a secret, a link works once, and it
  expires. The free-hosting abuse ADR-0001 guards against needs anonymous creation, which this
  does not allow. The key sits in the fragment, so it never reaches access logs, and Reveal is a
  `POST`, so a link preview cannot burn the secret.
- **The owner's handle works only through MCP.** A secret the owner creates in the UI gets a handle,
  `sec_<id>.<key>`, shown once. The agent redeems it with `claim_secret` for a single-use download
  URL that lasts 5 minutes. With auth on, a handle leaked from a transcript is useless without an
  API key.
- **The unavailable page does not distinguish.** Read, expired, and unknown ids get the same page.

## Considered options

- **Let MCP carry contents for secrets the agent generated itself.** Simpler, but the agent would
  have seen the secret, which defeats the purpose.
- **Require an owner session to reveal.** It adds a second factor, but it breaks the main use, a
  link opened on another device, and it does nothing when auth is off.
- **Keep the key on the server.** It would let a waiting page and server-side status show more, but
  a database or backup would then hold readable secrets.

## Consequences

- Muninn gains more security code in `src/secrets/`, reviewed like `src/auth/`.
- With auth off, anyone who can reach the server can call MCP, so a handle works for anyone on that
  network. That matches the trusted-network boundary.
- Muninn cannot stop an agent from printing a secret it fetched. Tool descriptions and the skill
  tell agents to pipe, never print.
