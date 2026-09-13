---
name: Ellamaka Docs AGENT RULES
description: Ellamaka documentation directory asset map, authority hierarchy, and maintenance responsibilities
---

# Agent Development Rules

## Canonical References

- DESIGN: `./DESIGN.md`
- API CONTRACT: `./API-CONTRACT.md`
- Parent rules: `../AGENTS.md`

## Directory Assets

This directory is ellamaka's design and documentation asset collection. Documents are organized into four categories by responsibility.

### Design Truth Sources

| Document | Responsibility | Maintenance |
|---|---|---|
| `DESIGN.md` | Architecture overview and customization index: runtime responsibilities, brand identity, space detection, configuration contract, ontology loading, state ownership, ellamaka and dsh dual-core architecture | Sync on architecture changes |
| `DESIGN-desktop.md` | Official desktop application architecture: Electron main process, sidecar hosting, window and PTY lifecycle | Sync on desktop implementation changes |
| `DESIGN-distribution.md` | Single source of truth for distribution and version identity: product SemVer, upstream lock, build identity, manifest, workflows, R2 CDN | Sync on release mechanism changes |
| `DESIGN-dsh-base.md` | dsh fusion foundation shared by both profiles: file territory, dependency closure, materialization, module hot reload | Sync on fusion mechanism changes |
| `DESIGN-dsh-web.md` | Web profile: plugin supply chain, plugin market, wopal plugin package, multi-profile decoupling, Workbench integration | Sync on Web profile changes |
| `DESIGN-ellamaka-tools.md` | Tool container profile: capability adoption, tool projection, sandbox, per-space configuration | Sync on tool container changes |
| `DESIGN-onboarding.md` | Desktop onboarding target implementation: entry determination, state machine, CLI machine invocation | Sync on onboarding flow changes |
| `DESIGN-workbench.md` | Workbench architecture choices, state model, and interaction flows | Sync on Workbench product design changes |

`DESIGN.md` is the document tree entry point and enumerates every sub-design in its header. Each sub-design points back with `上级: ./DESIGN.md`. Adding or removing a sub-design updates both sides.

### Companion Documents

| Document | Responsibility | Maintenance |
|---|---|---|
| `API-CONTRACT.md` | Runtime API and SDK contract: endpoint layering, domain semantics, schemas, errors, and compatibility | Sync on endpoint additions or modifications |

Companion documents are independent truth sources. They do not belong to the `DESIGN-<topic>.md` naming scheme and are declared as `Companion Documents` in `DESIGN.md`.

### Research and Reference Material

| Asset | Responsibility | Maintenance |
|---|---|---|
| `references/ellamaka-config-mechanism.md` | In-depth configuration mechanism reference | Sync on configuration mechanism changes |
| `research/deepseek-harness-architecture-and-integration-research.md` | dsh landscape research; the technical basis for the dsh design documents | Not actively updated; keep links consistent on change |
| `research/opencode/` | Upstream OpenCode architecture, mechanism, and SDK topic analyses | Not actively updated; keep links consistent on change |
| `research/claude-code/` | Claude Code architecture and agent SDK comparative research | Not actively updated; keep links consistent on change |
| `research/hermesAgent/` | hermes-agent in-depth research | Not actively updated; keep links consistent on change |
| `research/kilocode-upstream-merge-analysis.md` | kilocode upstream merge analysis | Not actively updated; keep links consistent on change |
| `research/workbench-git-files-review-analysis.md` | Workbench Git file review analysis | Not actively updated; keep links consistent on change |
| `research/session-timeline-virtual-scroll-issue.zh-CN.md` | Session timeline virtual scroll issue analysis | Not actively updated; keep links consistent on change |

Research material carries argumentation and analysis, providing the basis for design and implementation, and may be cited by design documents as authoritative evidence.

## Implementation Rules

### Single Source of Truth

- Each kind of fact has exactly one authoritative document. Design truth lives in `DESIGN*.md`; the API contract lives in `API-CONTRACT.md`. `DESIGN.md` keeps the customization index and points to the owning section instead of repeating details.
- Companion documents are never renamed to `DESIGN-<topic>.md` and never enter the sub-design enumeration.
- Before adding a top-level document, declare its responsibility and relationships in the `设计文档关系` table of `DESIGN.md`, then create the file.

### Document-Set Consistency

- When modifying any design document, check its parents, sub-designs, and siblings, correct statements that conflict with the change, and keep the bidirectional index consistent.
- After updating the top-level document set, run the `dev-doc-master` quality gate (`scripts/verify-docset.py`) and ensure it passes.

### Research Material Maintenance

- Research documents are not actively updated; their content stays unchanged.
- When a research document is renamed, moved, added, or removed, update every referencing location to keep links consistent.
- Historical documents belong in a `done/` or `archive/` directory rather than being stored under the guise of research material.

## User-Supplied Rules
