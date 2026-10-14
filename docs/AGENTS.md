---
name: Ellamaka Documentation AGENT RULES
description: Long-lived rules for maintaining Ellamaka design documents and Plan review aids
---

# Agent Development Rules

## Canonical References

- [Project rules](../AGENTS.md)
- [DESIGN index](./DESIGN.md)
- Document conventions (header fields, headings and references, target-state writing) are owned by the `dev-doc-master` skill; follow it instead of restating the format here.

## Architecture and Directories

The docs directory contains the main DESIGN, its linked sub-designs, and temporary review material such as GAPS. DESIGN.md owns the complete document index and detailed architecture.

Keep the distinction clear: AGENTS may retain a concise stable ownership map that helps implementation agents find the right module; it must not duplicate detailed DESIGN contracts or transient Plan scope.

## Development Commands

| Scenario | Command | When |
|---|---|---|
| DESIGN consistency check | python3 ../../../.wopal/skills/dev-doc-master/scripts/verify-docset.py . --main DESIGN.md | After document-set changes |

## Implementation Rules

- Update the DESIGN that owns a decision and check affected parent/sibling links for contradictions.
- DESIGN describes target state; progress and implementation tasks belong in Plans. Draft/Proposed material is not a committed implementation target.
- Compare Active design goals with real call paths and configuration when checking coverage; record uncertainty instead of relying on samples.
- GAPS is a temporary review/Plan aid: describe current difference, change type, and representative code entry. Keep task references until review confirms every gap has a Plan task; the user removes GAPS after that.
- Keep GAPS understandable and module-organized. Do not turn it into implementation steps or use it to expand speculative architecture.
- Preserve historical research/archive. Put current decisions in Active DESIGN and one-time audit evidence in isolated temporary artifacts.
- Follow the user's document format and lifecycle where they differ from generic templates; check user-format requirements independently.
- Keep main/sub-design links relative and verify file paths and section anchors after edits.

## Testing

- Run the available docset check after design-set edits. For a user-defined GAPS format that the generic checker does not accept, perform a separate completeness/link check and report the limitation.

## User-Supplied Rules

(None)
