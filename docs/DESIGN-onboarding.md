# Onboarding — WopalSpace 可选增强旅程

> **Status**: Active
> **Updated**: 2026-10-11
> **Parent**: `./DESIGN.md`
> **Sibling DESIGNs**:
>
> - `./DESIGN-dsh-base.md` — Core Runtime、固定 DSH Home、closure 变更备份与启动生命周期
> - `./API-CONTRACT.md` — 统一管理 API 与 SDK
> - `./DESIGN-desktop.md` — 宿主与 sidecar

## Ownership

Onboarding 的目标不是“让 Ellamaka 可以启动”，而是配置可选的 WopalSpace 增强能力。Ellamaka 的 Core Runtime Preparation 独立存在，`ellamaka`、`ellamaka run`、`serve/web` 与 Desktop 均可在 `OnboardingState != COMPLETED` 时正常 READY/RUNNING。

`ellamaka-onboarding` 只编排 ontology、Fork/GitHub、Space、WopalSpace profile/preset 与其他用户主动选择的增强能力；它拥有自己的 `NEEDS_INPUT`，但该状态不得传播成 Core Runtime 的 `SETUP_REQUIRED`。Core Runtime 的 closure、固定 DSH Home、closure-change backup、标准 profiles/plugins 与 activation 归 [DSH 基础设计](./DESIGN-dsh-base.md#closure-and-startup-lifecycle)；这些工作自动、幂等且无用户输入。Ellamaka 不把未知的 DSH Home 数据迁移包装成 Onboarding 步骤。

服务器不安装或调用 Wopal CLI 来完成 onboarding。Wopal CLI 是可选 SDK 消费者；安装 Ellamaka 制品由外部安装器完成。

## API and SDK

保留 `/api/onboarding/state|probe|execute|cancel|complete|stream` 的现有路径和响应形状，全部纳入 PublicApi/OpenAPI 与 `@wopal/ellamaka-sdk`。页面使用生成客户端，不维护旁路 fetch 和手写 DTO。setup、已有配置读取、wopalspace、dsh 的直接端点可供 SDK 远程消费者使用，调用时操作服务所在机器。

读状态与 probe 不初始化 Core Runtime；Core 由宿主自己的 `ensureCoreRuntimeReady()` 管理。Onboarding execute 只改变本旅程拥有的增强事实，不能通过任意路径输入切换整个服务的 `WOPAL_HOME` 或 Active DSH Home。

## Journey

典型旅程如下，除 system-check 外均属于按需增强，而不是 Ellamaka 启动前置：

```text
system-check -> ontology(optional) -> space(optional) -> provider(optional)
             -> wopalspace-enhancements(optional) -> done
```

| 阶段            | 行为                                                                                  |
| --------------- | ------------------------------------------------------------------------------------- |
| 系统检查        | 显示当前 Core Runtime、OnboardingState 与已有 WopalSpace 能力；只读                   |
| Ontology        | clone/reuse；默认 clone 不需要 GitHub；只有用户主动选择贡献/Fork 时才进入 GitHub 授权 |
| Space           | 可选创建或注册；没有 Space 不影响普通 Ellamaka directory/TUI/run                      |
| Provider        | 可选外部 provider/model；Ellamaka 自带免费模型，因此零外部 provider 配置可正常使用    |
| WopalSpace 增强 | 按已有 ontology/Space 物化可选 preset/profile 等增强能力                              |
| 完成            | 记录 Onboarding 旅程状态；不负责启动或解锁 Core Runtime                               |

`NEEDS_INPUT` 只允许出现在用户主动进入的交互分支，例如 Fork/GitHub 授权、明确选择 Space 类型或外部 provider 凭据。用户跳过这些可选项时不得被阻塞。

`ELLAMAKA_DSH=0` 时 Onboarding 不得为了 WopalSpace 增强重新创建或准备 DSH；DSH 专属增强显示为 disabled/skipped，其余 ontology/Space 能力仍按自身契约处理。

## Host Entry Behavior

| 入口                     | Core Runtime                                                           | Onboarding                                                    |
| ------------------------ | ---------------------------------------------------------------------- | ------------------------------------------------------------- |
| `ellamaka serve` / `web` | 自动 `ensureCoreRuntimeReady()` 并 activation；与 OnboardingState 解耦 | Web/Workbench 可按状态展示向导，但不能阻塞正常 runtime API    |
| Desktop                  | sidecar 自动准备并 activation Core                                     | Renderer 可展示 Onboarding；用户暂不完成仍可使用原生 Ellamaka |
| `ellamaka run`           | 自动准备 Core 后直接执行                                               | 不进入 Onboarding                                             |
| `ellamaka`（默认 TUI）   | 自动准备 Core 后直接启动 TUI                                           | 不进入 Onboarding                                             |
| attach / `run --attach`  | 使用远端宿主                                                           | 本地 Onboarding 不参与                                        |
| `ellamaka setup`         | 必要时可先确认 Core 可用                                               | 显式进入本 Onboarding 旅程                                    |

Core startup 的 DSH 准备、closure-change backup 与用户可见进度契约见 [DSH 基础设计](./DESIGN-dsh-base.md#core-preparation-progress-contract)。

## Progress and Completion

Onboarding 继续复用已有执行互斥、AbortController、SSE progress/log/error/complete 和取消入口，不新建任务调度系统。它的事件只描述 Onboarding 自己的可选旅程，不冒充 Core Runtime progress。

Core Preparation 使用独立的 `CoreProgressEvent`。因此页面可以同时明确显示“Ellamaka runtime 已运行”和“WopalSpace onboarding 尚未完成”，不会把两套状态混成一个 loading。

`onboarding.json` 只承载 UI 旅程恢复/展示和 completed 标记，不代表 Core Runtime readiness。结果用 created/reused/skipped 表示增强事实；failed/cancelled 不计完成。完成检查只验证用户选择执行的 Onboarding 项目，不要求 ontology、Space、外部 provider 或 DSH 必须存在。
