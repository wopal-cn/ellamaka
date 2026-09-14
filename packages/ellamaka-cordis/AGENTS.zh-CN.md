---
name: ellamaka-cordis 规则
description: DSH 融合桥接包 — cordis 容器边界、运行时闭包物化、插件供应链与双 profile 装配
---

# Agent 开发规则

## 规范引用

- 上级规则: `../../AGENTS.md`
- 融合基础: `../../docs/DESIGN-dsh-base.md`
- 工具容器: `../../docs/DESIGN-ellamaka-tools.md`
- Web profile: `../../docs/DESIGN-dsh-web.md`
- 主设计: `../../docs/DESIGN.md`

## 架构与目录

本包是 ellamaka 与 dsh 运行时之间的桥接层，编译进 CLI 二进制与 Desktop sidecar。它同时承担三个职责：进程内 cordis 容器的唯一入口、dsh 运行时闭包的物化与动态加载、插件供应链。

| 目录 | 职责 |
|------|------|
| `src/hub.ts` | `CordisHub` — 仓库内唯一的 cordis 边界，持有 `Context` 生命周期 |
| `src/dsh-web.ts` | 按 profile 重放 dsh boot 序列：`mountDshWeb` / `bootDshWeb`（web）、`mountDshTools` / `bootDshTools`（ellamaka-tools） |
| `src/dsh-virtual-webserver.ts` | `VirtualWebServer` — 实现官方 WebServer 接口，持有路由与 upgrade 分发 |
| `src/runtime/` | Runtime Manager：运行时清单、内嵌锁、闭包物化、installAnchor 解析与状态机 |
| `src/plugins/` | 插件供应链：profile 声明、解析器、安装器、组合装配、补丁层、HMR 适配器、市场安装工 |
| `src/log-bridge.ts` | `createCordisLogExporter` — 把插件 `ctx.logger` 桥接进 ellamaka `Log` 体系 |
| `script/` | 构建期清单与锁生成器，带 `--check` 漂移门禁 |
| `generated/` | 入仓库的构建产物：`dsh-runtime-manifest.json`、`dsh-runtime-lock.json` |
| `test/` | 包级测试；`probe-*.ts` 是手动挂载探针，不是单元测试 |

## 开发命令

所有命令从 `packages/ellamaka-cordis/` 运行。

| 场景 | 命令 |
|------|------|
| 全量测试 | `bun test` |
| 单元测试 | `bun run test:unit` |
| 集成测试 | `bun run test:integration` |
| 类型检查 | `bun run typecheck` |
| 重建运行时清单 | `bun script/generate-dsh-runtime-manifest.ts` |
| 重建运行时锁 | `bun script/generate-dsh-runtime-lock.ts` |
| 校验生成物漂移 | `bun script/generate-dsh-runtime-manifest.ts --check` |

## 实现规则

- **单一 cordis 边界**：`@deepseek-ai/cordis` 的 import 全部收敛在本包内。值导入在构建期擦除，运行时经 installAnchor 解析。生产挂载点一律注入闭包解析出的 context，`hub.ts` 中的包内回退只服务源码开发态。
- **契约自持**：契约形状借鉴 dsh，但不在本包 import dsh 契约包，也不跟随其 rc 版本演进。外部插件通过契约符合性冒烟测试后才允许挂载。
- **Bridge 不进闭包**：本包是 ellamaka 发布物的一部分，不发布为独立 registry 包，也不作为 `$WOPAL_HOME/dsh/package.json` 的依赖。
- **生成物禁止手改**：`generated/` 下的清单与锁由 `script/` 生成，`package.json` 的 dependencies 是 dsh 直接依赖版本的唯一编辑源。升级流程是改版本、`bun install`、重新生成。
- **测试隔离**：任何会触碰 `$WOPAL_HOME/dsh/home/profiles/` 的测试、转储与诊断，都通过注入 `dshHome` / `installAnchor` 跑在临时 home 上。
- **不开监听 socket**：`VirtualWebServer` 只提供路由注册与 upgrade 分发，监听端口归 ellamaka 主服务器。
- **桥接只做加法**：新增桥接以新文件或包装层落地，删除即完整回滚；不为了腾位置改动上游文件。

## 测试

- 代码变更遵循 TDD：先写失败测试，再实现使其通过。
- 必须自动化覆盖：闭包物化状态机、清单与锁的生成与漂移校验、插件解析与安装、profile 声明读写、补丁层组合、VirtualWebServer 路由分发。
- 集成测试覆盖需要真实 cordis 容器装配的路径（`plugins-runtime.test.ts`、`dsh-web.test.ts`），它们单独归入 `test:integration`，不进默认单元集合。
- 跨包行为由 opencode 侧测试承接：`packages/opencode/test/cli/serve/dsh-mount.test.ts`、`packages/opencode/test/cli/cmd/tui/dsh-mount.test.ts`、`packages/opencode/test/server/dsh-single-port.test.ts` 及 `test/cli/cmd/dsh-*.test.ts` 一组。本包改动后这些测试必须保持通过。
- 真实宿主边界（打包二进制中的 installAnchor 解析、Desktop utilityProcess 挂载）依赖手动冒烟，通过 `test/probe-*.ts` 在真实闭包上验证。

## 用户规则

（无）
