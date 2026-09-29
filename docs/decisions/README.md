# Decisions

Architecture decision records for Artifacts, numbered in the order they were made. An `accepted`
decision binds the code: a change that contradicts it needs a new record that supersedes it. A
`proposed` decision may still change. `superseded` and `deprecated` records are kept for history
and do not bind anything.

| Record | Status | Decision |
| --- | --- | --- |
| [0001](0001-opt-in-owner-auth.md) | accepted | An owner password turns on login; without one, Artifacts keeps its no-auth, trusted-network boundary. |
| [0002](0002-signed-artifact-urls.md) | accepted | A short-lived signed URL reads one artifact without a session; the thumbnail renderer uses one per render. |
| [0003](0003-signed-embed-urls.md) | accepted | An HTML artifact's embedded `/a/:id` URLs are found when it is stored and signed again on every view. |
| [0004](0004-hourly-url-signing-keys.md) | accepted | Signed URLs use one random key per clock hour, stored in the database, and verify only against the current and previous hour's keys. |
| [0005](0005-per-client-login-limit.md) | accepted | Logins are limited per client address, read from a header only when the operator names it, under a total ceiling; a password shorter than 16 characters stops startup. |
