<p align="center">
  <h1 align="center">Ellamaka</h1>
</p>
<p align="center">Train your agent well. Once is enough.</p>
<p align="center">
  <a href="https://github.com/wopal-cn/ellamaka/releases"><img alt="GitHub Release" src="https://img.shields.io/github/v/release/wopal-cn/ellamaka?style=flat-square&label=release" /></a>
  <a href="https://github.com/wopal-cn/ellamaka/actions/workflows/publish-ellamaka-cli.yml"><img alt="Build" src="https://img.shields.io/github/actions/workflow/status/wopal-cn/ellamaka/publish-ellamaka-cli.yml?style=flat-square" /></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square" /></a>
</p>

---

You spend weeks fine-tuning an AI agent until it finally gets you — it knows your code style, understands your project structure, and senses when to ask and when to just get things done.

Then you start a new project.

Everything resets to zero.

Rules need rewriting. Agents need redefining. Workflows need rebuilding. All that hard-won experience stays trapped in the old project directory.

Ellamaka solves exactly this: **turn your polished agent configuration into portable assets that follow you everywhere.**

## How It Works

Ellamaka is the execution engine for [WopalSpace](https://github.com/wopal-cn/wopal-space-ontology), built on [OpenCode](https://github.com/anomalyco/opencode). Its core innovation is upgrading the agent configuration model from "scattered files" to a "structured ontology."

What's an ontology? Everything you define for your agent — personality, commands, skills, permissions — lives in a `.wopal/` directory, version-controlled like code. Then:

```text
Project A: you spend time crafting a great agent setup
   │
   │  Fork the ontology
   ▼
Project B: agent arrives at peak performance. You focus on the new project,
           not on retraining it.
```

The ontology travels with your projects. Memory stays local. Your expertise is replicable. Your privacy never leaves your machine.

## How It Differs from OpenCode

OpenCode is a powerful general-purpose AI coding agent. Ellamaka does one thing on top of it: **make agent configuration a first-class citizen.**

| | OpenCode | Ellamaka |
|---|---|---|
| Config model | Per-project, independent | Ontology-level, reusable across projects |
| Release cadence | Continuous, frequent API changes | Selective upstream merges, predictable behavior |
| Runtime | CLI + Web UI + Desktop | CLI + Web UI dual-mode, focused core experience |
| Data isolation | Shares paths with system config | Isolated data directory, no interference with OpenCode |
| Extension system | In-project plugins | Ontology-level plugins + skills, carried by fork |

## Try It

Ellamaka works standalone or as part of WopalSpace:

```bash
# Install
wopal ellamaka install

# Or download directly: https://github.com/wopal-cn/ellamaka/releases

# Launch from any directory — it's your AI partner
ellamaka
```

## Development

| Action | Command |
|---|---|
| Start TUI | `./scripts/dev.sh tui` |
| Start Workbench | `./scripts/dev.sh serve` |
| Start Desktop dev | `./scripts/dev.sh desktop` |
| Build CLI binary | `./scripts/build.sh cli` |
| Build Desktop app | `./scripts/build.sh desktop` |
| Branded build | `bun packages/ellamaka-release/src/cli/build.ts` |
| Type check | `bun typecheck` |
| Clean up after upstream merge | `./scripts/check-cleanup.sh --clean` |
| Browse API docs | `bun ./scripts/scalar-doc.ts` |

See `AGENTS.md` for details.

## Learn More

| Doc | Contents |
|---|---|
| `docs/DESIGN.md` | Architecture design & WopalSpace adaptation |
| `docs/DESIGN-distribution.md` | Release process & artifact specs |
| `docs/BRANDING.md` | Branding changes inventory |
| `docs/UPSTREAM-MERGE-LOG.md` | Upstream merge history |

## License

Forked from OpenCode, under MIT. See `LICENSE`.
