# {{TITLE}}

{{ONE_LINE_SUMMARY_OF_WHAT_THE_DIAGRAM_SHOWS}}

## Diagram

```mermaid
flowchart TD
    A[{{STEP_1}}] --> B[{{STEP_2}}]
    B --> C{{{DECISION_POINT}}}
    C -->|yes| D[{{STEP_3}}]
    C -->|no| E[{{STEP_4}}]
```

Swap the block above for the mermaid diagram type that fits — `sequenceDiagram` for
request/response flows, `classDiagram` for data shapes, `erDiagram` for schemas,
`stateDiagram-v2` for state machines — this scaffold only shows `flowchart`.

## Key Points

- {{POINT_1}}
- {{POINT_2}}

## Notes

{{ANY_ADDITIONAL_CONTEXT_NOT_OBVIOUS_FROM_THE_DIAGRAM}}
