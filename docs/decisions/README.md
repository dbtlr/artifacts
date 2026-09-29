# Decisions

Architecture decision records for Artifacts, numbered in the order they were made. An `accepted`
decision binds the code: a change that contradicts it needs a new record that supersedes it. A
`proposed` decision may still change. `superseded` and `deprecated` records are kept for history
and do not bind anything.

| Record | Status | Decision |
| --- | --- | --- |
| [0001](0001-opt-in-owner-auth.md) | accepted | An owner password turns on login; without one, Artifacts keeps its no-auth, trusted-network boundary. |
