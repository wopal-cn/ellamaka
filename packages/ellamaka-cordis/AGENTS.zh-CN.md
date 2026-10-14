---
name: ellamaka-cordis rules
description: ellamaka-cordis 长期有效的 DSH 桥接、运行时闭包、profile 与验证规则
---

# Agent Development Rules

## Canonical References

- [项目规范](../../AGENTS.md)
- [DSH 基础设计](../../docs/DESIGN-dsh-base.md)
- [DSH Web profile 设计](../../docs/DESIGN-dsh-web.md)
- [Ellamaka tools profile 设计](../../docs/DESIGN-ellamaka-tools.md)

## Architecture and Directories

ellamaka-cordis 是随 Ellamaka CLI 和 Desktop 分发的产品 DSH Bridge。它拥有 DSH import 边界，并负责适配 DSH 与宿主 Server/Runtime。

| 路径 | 职责 |
|---|---|
| src/hub.ts | Cordis context 边界和生命周期 |
| src/dsh-web.ts | 装配 web 与 ellamaka-tools 两个 profile |
| src/dsh-virtual-webserver.ts | 在 Ellamaka Server listener 上注册和分发 DSH 路由/upgrade |
| src/runtime/ | 解析并物化产品运行时闭包 |
| src/plugins/ | profile 声明、插件组合、安装和运行时更新 |
| src/log-bridge.ts | 将 Cordis 插件日志接入 Ellamaka 日志系统 |
| generated/、script/ | 运行时 manifest/lock 生成物及生成器 |

请遵守这些归属事实：

- 所有 @deepseek-ai/cordis 运行时 import 都留在本包内。产品闭包提供运行时实例，不能用宿主上无关的副本替代。
- web 是 DSH UI/Session profile；ellamaka-tools 是无 Session 的工具 profile。不得把 DSH Session/agent loop provider 搬入 Ellamaka native tools。
- 监听 socket 归 Ellamaka Server。VirtualWebServer 注册并分发路由，不另起 listener。
- package.json dependencies 是直接版本输入；不得手改 generated runtime manifest/lock，通过 script/ 下生成器更新并检查。
- Profile/插件变更走包内串行更新路径。失败时报告实际 Runtime 状态，不假定旧 profile 仍在运行。
- 触及 DSH Home 的测试和诊断必须注入临时 Home 与 install anchor。

## Development Commands

从 packages/ellamaka-cordis/ 运行。

| Scenario | Command | When |
|---|---|---|
| 全量测试 | bun test | 全部 Cordis 测试 |
| 单元测试 | bun run test:unit | 纯逻辑/模块测试 |
| 集成测试 | bun run test:integration | 真实 Cordis 装配 |
| 类型检查 | bun run typecheck | 修改 TypeScript 后 |
| 重建 manifest | bun script/generate-dsh-runtime-manifest.ts | 闭包输入变化后 |
| 重建 lock | bun script/generate-dsh-runtime-lock.ts | 闭包输入变化后 |
| 检查 manifest 漂移 | bun script/generate-dsh-runtime-manifest.ts --check | 交付前 |

## Implementation Rules

- DSH Bridge 边界留在本包；只适配已证实的宿主差异，不复制上游子系统或预判私有 API。
- Server 是 listener owner；显式注入选定的产品运行时和 profile。
- 串行化持久 profile 修改；取消或关闭时回收本包拥有的 worker/子进程。
- 使用 ctx.logger 输出稳定结构化消息；脱敏用户/配置/凭证值，并限制上游诊断长度。
- 通过真实产品闭包验证运行时解析和包宿主行为，仅源码解析测试不足以证明制品路径。
- Bridge 保持 additive：新桥以新文件或 wrapper 引入，删除即完整回滚；不为容纳新桥而重构 upstream 文件。
- Bridge 不进 closure：只随 Ellamaka 产品发布，不作为独立 registry 包、也不声明为 `$WOPAL_HOME/dsh` 的依赖。

## Testing

- 对本次改动涉及的 metadata、installer、profile 或 container 边界遵循 TDD。
- 纯 contract tests 保持确定性；真实 container/host 集成放入 integration suite。
- 通过真实宿主路径检查打包闭包解析和 Electron utility-process 行为，源码测试不能证明这些边界。

## User-Supplied Rules

（无）
