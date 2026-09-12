---
name: opencode package AGENT RULES
description: Main inherited OpenCode engine package for CLI, runtime, config, server, session, tools, storage, and TUI integration
---

# Agent Development Rules

## Canonical References

权威引用：

- Project DESIGN: `../../docs/DESIGN.md`
- Parent Rules: `../../AGENTS.md`
- Test Rules: `test/AGENTS.md`
- Server Test Rules: `test/server/AGENTS.md`
- Instance Route Rules: `src/server/routes/instance/AGENTS.md`
- HttpApi Route Rules: `src/server/routes/instance/httpapi/AGENTS.md`
- Effect Migration Reference: `specs/effect/migration.md`

## Architecture and Directories

执行链：CLI entry → config/runtime services → server/session/tool/storage/TUI → WopalSpace hooks。

本目录是 ellamaka 的 engine 主包。它承载 OpenCode inherited runtime，并接入 WopalSpace config、plugin、agent、command、permission 和 TUI hooks；WopalSpace 定制边界遵循父级 `../../AGENTS.md`。

| 目录 | 职责 |
|---|---|
| `src/cli/` | CLI commands、TUI command entry 和 command-specific runtime glue |
| `src/config/` | config schema、loading、merge、command/agent/plugin 配置与 wopal-space config hooks |
| `src/server/` | Hono / Effect HttpApi server、routes、middleware 和 adapters |
| `src/session/` | session lifecycle、messages、events、retry/status 等 session domain logic |
| `src/tool/` | tool definitions、permission-facing tool behavior 和 runtime execution surfaces |
| `src/storage/` | database access、storage adapters 和 persisted runtime data |
| `src/effect/` | shared Effect runtime helpers、InstanceState 和 service runtime utilities |
| `src/permission/` | permission matching、merge 和 tool authorization behavior |
| `src/plugin/` | plugin loading、plugin origin handling 和 plugin runtime integration |
| `test/` | package-local tests and fixtures；详细规则见 `test/AGENTS.md` |
| `migration/` | Drizzle migration output |

## Development Commands (build format test)

| 场景 | 命令 | 何时 |
|---|---|---|
| Dev | `bun run dev` | 本地运行 package dev entry |
| Typecheck | `bun typecheck` | 修改 TypeScript 后；不要直接运行 `tsc` |
| Test（默认子集） | `bun run test:unit` | 修改 package behavior 后（只跑快速单元测试，约 60s） |
| Test（重目录集成） | `bun run test:integration` | 修改 server/session/cli/snapshot/project/tool/control-plane 相关行为后 |
| Test（e2e） | `bun run test:e2e` | 修改真实 provider 链路 / 浏览器 e2e 测试后 |
| Test（全量回归） | `bun run test:all` | 完整回归（等价 `bun test --timeout 30000 --force-exit`） |
| Build | `bun run build` | 修改 runtime、CLI、package build 或发布相关代码后 |
| Database migration | `bun run db generate --name <slug>` | schema 变化需要生成 migration 时 |

所有命令从 `packages/opencode` 目录运行。

## Implementation Rules

- 遵循父级 `../../AGENTS.md` 的 Bun、TypeScript、WopalSpace mode、上游定制边界和验证规则。
- 禁止用 `export namespace Foo { ... }` 组织模块；使用 flat top-level exports，并在文件底部 self-reexport，例如 `export * as Foo from "./foo"`。
- 单文件模块名为 `index.ts` 时，self-reexport source 使用 `"."`，不要用 `"./index"`。
- 多 sibling 目录不要添加 barrel `index.ts`；消费者直接 import 具体 sibling，例如 `@/session/retry`。
- namespace-private helpers 保持为同文件 non-exported top-level declarations。
- `src/config` 新增模块时遵循现有 self-export pattern，例如 `export * as ConfigAgent from "./agent"`。
- Drizzle schema 位于 `src/**/*.sql.ts`。
- Drizzle table 和 column 使用 snake_case；join columns 使用 `<entity>_id`；indexes 使用 `<table>_<column>_idx`。
- migration 由 Drizzle Kit 生成到 `migration/<timestamp>_<slug>/migration.sql` 和 `snapshot.json`。
- migration tests 读取 per-folder layout；不要依赖 `_journal.json`。
- 使用 `Effect.gen(function* () { ... })` 组合 Effect。
- 使用 `Effect.fn("Domain.method")` 命名和追踪公开 effects；内部 helpers 使用 `Effect.fnUntraced`。
- `Effect.fn` / `Effect.fnUntraced` 可直接接收 pipeable operators；避免不必要的外层 `.pipe()`。
- callback-based APIs 使用 `Effect.callback`。
- 使用 `Effect.void`，不要用 `Effect.succeed(undefined)` 或 `Effect.succeed(void 0)`。
- 需要 `Date` 时优先 `DateTime.nowAsDate`，不要用 `new Date(yield* Clock.currentTimeMillis)`。
- multi-field data 使用 `Schema.Class`；single-value types 使用 branded schemas。
- typed errors 使用 `Schema.TaggedErrorClass`；defect-like causes 使用 `Schema.Defect`。
- 在 `Effect.gen` / `Effect.fn` 中直接 `yield* new MyError(...)`，不要包一层 `Effect.fail(new MyError(...))`。
- 所有 services 使用 `makeRuntime` (from `src/effect/run-service.ts`)。It returns `{ runPromise, runFork, runCallback }` backed by a shared memoMap that deduplicates layers.
- per-directory state（需 per-instance cleanup）使用 `InstanceState` (`src/effect/instance-state.ts`)，基于 ScopedCache 按 directory 隔离，自动 dispose；需要目录隔离的 service 必须用它。
- `InstanceState.make` closure 内直接完成 work，cleanup 用 `Effect.addFinalizer` / `Effect.acquireRelease`，background consumers 用 `Effect.forkScoped`；不额外加 fibers、`ensure()`、`started` flags。
- `bootstrap.ts` 已将 `init()` 包装为 fire-and-forget，service 内部 `init()` 保持 synchronous；如需非阻塞在调用点 fork，不在 make closure 内 fork。
- Effect v4 beta 没有 `Effect.fork` 和 `Effect.forkDaemon`；使用 `Effect.forkIn(scope)`。
- Effect 服务中优先 yield 既有 Effect services；避免直接使用 ad hoc platform APIs。
- effectful file I/O 优先 `FileSystem.FileSystem`，process 优先 `ChildProcessSpawner.ChildProcessSpawner` + `ChildProcess.make(...)`，HTTP 优先 `HttpClient.HttpClient`。
- 已在 Effect 代码中时，优先使用 `Path.Path`、`Config`、`Clock`、`DateTime`。
- background loops 或 scheduled tasks 使用 `Effect.repeat` 或 `Effect.schedule`，并用 `Effect.forkScoped` 挂到 layer scope。
- 多个并发调用需要共享同一个 in-flight computation 时使用 `Effect.cached`，不要手写 `Fiber | undefined` 或 `Promise | undefined` 缓存。See `specs/effect/migration.md` for the full pattern.
- native addon callbacks 需要读取 `Instance.directory` 或调用 `Bus.publish` 时，使用 `Instance.bind(fn)` 捕获并恢复 Instance AsyncLocalStorage context。
- `setTimeout`、`Promise.then`、`EventEmitter.on` 或 Effect fibers 不需要 `Instance.bind`。
- 修改 `src/server/routes/instance/` 时保持 legacy Hono routes 与 Effect HttpApi 行为对齐；详细规则见对应子目录 `AGENTS.md`。
- 修改 `src/server/routes/instance/httpapi/` 时遵循 HttpApi route patterns；不要在 request handler 中重建 stable layers。

## Testing

- 测试子集由 `script/run-tests.ts` 按层展开，`package.json` 提供四个入口：`test:unit`（默认开发子集，扫 `test/` 全部子目录 + 顶层 `*.test.ts`，剔除集成目录与 `*-e2e.test.ts`）、`test:integration`（只跑 7 个集成目录：server/session/cli/snapshot/project/tool/control-plane）、`test:e2e`（只跑 `*-e2e.test.ts` 文件，递归）、`test:all`（全量回归）。日常开发默认用 `test:unit`；改到集成目录（server/session/cli/snapshot/project/tool/control-plane）相关代码时至少跑 `test:integration`；提交/合并前跑 `test:all` 回归。
- e2e 文件遵循 `*-e2e.test.ts` 命名约定，通过 `pathIgnorePatterns` 从 `test:unit`/`test:integration` 隔离（CLI 值覆盖 bunfig，不合并），只在 `test:e2e` 下运行。不要将 e2e 文件移出所属 domain 目录。
- 新增测试目录默认自动纳入 `test:unit`（扫描式）；若某目录属于集成（真实 I/O），把目录名加入 `script/run-tests.ts` 的 `INTEGRATION_DIRS` 常量，并在本文件集成目录清单同步。
- 跨包编排：从 repo root 运行 `bun run test:unit|test:integration|test:e2e` 会通过根目录 `script/run-tests.ts` 在所有 package 上跑对应层；用 `--package <name>` 指定单个 package（如 `bun run test:unit --package opencode`）。
- 代码类变更遵循 TDD：先写能失败的测试，再实现代码使其通过。
- 测试从 `packages/opencode` 运行；不要从 repo root 运行测试。
- 测试真实实现，避免 mocks；不要把实现逻辑复制进测试。
- Effect services 或 Effect workflows 使用 `testEffect(...)` from `test/lib/effect.ts`。
- 默认用 `it.instance(...)` 测试需要一个临时 instance 的场景。
- 测试需要 real time、filesystem mtimes、child processes、git、locks 或 OS behavior 时使用 `it.live(...)`。
- 测试可用 `TestClock` 和 `TestConsole` 时使用 `it.effect(...)`。
- 需要临时目录时优先使用 `tmpdir`、`tmpdirScoped`、`provideTmpdirInstance` 或 `provideTmpdirServer` from `test/fixture/fixture.ts`。
- Server 和 HttpApi middleware tests 遵循 `test/server/AGENTS.md`，优先 focused middleware tests 和 Effect HTTP stack。
- 修改 legacy Hono / Effect HttpApi 路由时，添加或更新 parity coverage，例如 `test/server/httpapi-bridge.test.ts` 或 focused HttpApi tests。
- 修改 database schema 时生成 migration，并添加或更新 migration tests。
- 修改 CLI/runtime/config/plugin/agent/TUI space mode 后，验证或说明 `WOPAL_SPACE` flag、`.wopal/config/settings.*`、TUI settings、plugin loading、theme loading。
- Windows 的 Git 克隆通常使用 `core.symlinks=false`；插件解析器必须把内容为受限相对源码路径的扁平化 symlink 占位文件解析到同一插件目录内的真实文件，并拒绝目录越界目标。

## User-Supplied Rules

### Module Shape

Do not use `export namespace Foo { ... }` for module organization. It is not standard ESM, it prevents tree-shaking, and it breaks Node's native TypeScript runner. Use flat top-level exports combined with a self-reexport at the bottom of the file:

```ts
// src/foo/foo.ts
export interface Interface { ... }
export class Service extends Context.Service<Service, Interface>()("@opencode/Foo") {}
export const layer = Layer.effect(Service, ...)
export const defaultLayer = layer.pipe(...)

export * as Foo from "./foo"
```

Consumers import the namespace projection:

```ts
import { Foo } from "@/foo/foo"

yield * Foo.Service
Foo.layer
Foo.defaultLayer
```

Namespace-private helpers stay as non-exported top-level declarations in the same file — they remain inaccessible to consumers (they are not projected by `export * as`) but are usable by the file's own code.

#### When the file is an `index.ts`

If the module is `foo/index.ts` (single-namespace directory), use `"."` for the self-reexport source rather than `"./index"`:

```ts
// src/foo/index.ts
export const thing = ...

export * as Foo from "."
```

#### Multi-sibling directories

For directories with several independent modules (e.g. `src/session/`, `src/config/`), keep each sibling as its own file with its own self-reexport, and do not add a barrel `index.ts`. Consumers import the specific sibling:

```ts
import { SessionRetry } from "@/session/retry"
import { SessionStatus } from "@/session/status"
```

Barrels in multi-sibling directories force every import through the barrel to evaluate every sibling, which defeats tree-shaking and slows module load.

### Instance.bind — ALS for native callbacks

`Instance.bind(fn)` captures the current Instance AsyncLocalStorage context and restores it synchronously when called.

Use it for native addon callbacks (`@parcel/watcher`, `node-pty`, native `fs.watch`, etc.) that need to call `Bus.publish` or anything that reads `Instance.directory`.

You do not need it for `setTimeout`, `Promise.then`, `EventEmitter.on`, or Effect fibers.

```typescript
const cb = Instance.bind((err, evts) => {
  Bus.publish(MyEvent, { ... })
})
nativeAddon.subscribe(dir, cb)
```