---
type: adr
title: ADR-0004 - Signed URLs use an hourly key stored in the database
description: Each clock hour has one random signing key in the metadata database. A URL verifies only against the current and previous hour's keys, so no signed URL works for more than about two hours.
status: accepted
created: 2026-09-29
modified: 2026-09-29
---
# ADR-0004 - Signed URLs use an hourly key stored in the database

## Context

[ADR-0002](0002-signed-artifact-urls.md) signed artifact URLs with 32 random bytes made when the
process started. On Cloudflare, each Worker instance would make its own key, so a URL signed by
one instance would fail on another. A per-process key also has no upper bound on its age: a
long-running process keeps one key for as long as it runs.

A signed thumbnail or embed URL must not turn into free file hosting for whoever holds a copy. The
key does not need to be secret from someone who can read the database, because that reader can
already read every artifact.

## Decision

- **One key per clock hour, in the metadata database.** The table `url_signing_keys` holds a
  random 256-bit key for each bucket, where the bucket is the Unix time in seconds divided by 3,600
  and rounded down. The migration is a shared `.sql` file, so SQLite and D1 have the same table.
- **The first process to need a key makes it.** It inserts a random key for the current bucket if
  the bucket has none, then reads the bucket's key back. An insert never replaces a key, so
  processes that sign at the same moment all use the first key stored.
- **Sign with the current hour, verify with the current and previous hour.** A URL signed just
  before the hour still works for its full lifetime, which is at most 15 minutes. A URL whose key
  is two or more hours old fails, whatever its expiry says. This bounds every signed URL to about
  two hours even if the expiry check were wrong or a caller asked for a long lifetime.
- **Old keys are deleted.** Making a bucket's key deletes every key older than the previous bucket.
- **Processes keep keys in memory.** A stored key never changes, and no key is made for an hour
  that has passed, so each process caches the keys it can still use and the past hours that have
  none. It reads the database about once an hour, not once per signed URL. Until some process
  signs in a new hour, a check also looks for that hour's key in the database.

## Considered options

- **A key from a configured secret.** One more secret for every deployment to create and keep. A
  fixed key also never expires, so the expiry check would be the only bound on a URL's life.
- **Put the bucket in the URL.** It would save one HMAC per failed check. Trying two keys is cheap,
  and it keeps the URL format unchanged.
- **Refuse lifetimes over an hour.** Every lifetime in use is 15 minutes or less. The two-key rule
  already cuts a longer URL short, so a separate check adds nothing.

## Consequences

- A restart no longer voids outstanding URLs. They stay valid until they expire.
- Every process that shares a database accepts URLs that any of them signed.
- Anyone who can read the database can sign URLs for up to two hours. That reader already has
  every artifact.
- Deleting rows from `url_signing_keys` does not void URLs at once. A running process keeps its
  cached keys until they are two hours old.
