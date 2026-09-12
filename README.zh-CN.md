<p align="center">
  <h1 align="center">Ellamaka</h1>
</p>
<p align="center">把你的 Agent 调教好。一次就够了。</p>
<p align="center">
  <a href="https://github.com/wopal-cn/ellamaka/releases"><img alt="GitHub Release" src="https://img.shields.io/github/v/release/wopal-cn/ellamaka?style=flat-square&label=release" /></a>
  <a href="https://github.com/wopal-cn/ellamaka/actions/workflows/publish-ellamaka-cli.yml"><img alt="Build" src="https://img.shields.io/github/actions/workflow/status/wopal-cn/ellamaka/publish-ellamaka-cli.yml?style=flat-square" /></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square" /></a>
</p>

---

你花了几周时间，把一个 AI Agent 调教得称心如意——它懂你的代码风格，熟悉你的项目结构，知道什么时候该问、什么时候该放手干。

然后你开了个新项目。

一切归零。

规则要重写，Agent 要重新定义，工作流要重新搭。你积累的经验困在旧项目的目录里，带不走。

Ellamaka 要解决的就这一件事：**让你打磨好的 Agent 配置，变成可以跟着你走的资产。**

## 怎么做到的

Ellamaka 是 [WopalSpace](https://github.com/wopal-cn/wopal-space-ontology) 的执行引擎，基于 [OpenCode](https://github.com/anomalyco/opencode) 构建。它的核心创新，是把 Agent 的配置体系从"散落文件"升级为"结构化本体"。

什么叫本体？就是你为 Agent 定义的一切——人格、命令、技能、权限——被组织在 `.wopal/` 目录里，像代码一样版本管理。然后：

```text
项目 A：你花时间打磨了一套好用的 Agent 配置
   │
   │  Fork 本体
   ▼
项目 B：Agent 到岗即巅峰。你专注于新项目本身，不需要重新教它。
```

本体跟着项目走。记忆留在本地。你的经验可以被复制，你的隐私不会被带走。

## 和 OpenCode 有什么不同

OpenCode 是一个强大的通用 AI coding agent。Ellamaka 在它的基础上，做了一件事：**让 Agent 的配置变成一等公民。**

| | OpenCode | Ellamaka |
|---|---|---|
| 配置模型 | 项目级，每项目独立 | 本体级，跨项目可复用 |
| 版本节奏 | 持续发布，API 频繁变动 | 选择性合并上游，版本行为可预期 |
| 运行环境 | 命令行 + Web UI + 桌面端 | 命令行 + Web UI 双模，专注核心体验 |
| 数据隔离 | 与系统配置共享路径 | 独立数据目录，与 OpenCode 互不干扰 |
| 扩展体系 | 项目内插件 | 本体级插件 + 技能，Fork 即携带 |

## 试试看

Ellamaka 可以独立使用，也可以作为 WopalSpace 的一部分：

```bash
# 安装
wopal ellamaka install

# 或直接下载：https://github.com/wopal-cn/ellamaka/releases

# 在任意目录启动——它就是你的 AI 搭档
ellamaka
```

## 参与开发

| 做什么 | 命令 |
|---|---|
| 启动 TUI | `./scripts/dev.sh tui` |
| 启动 Workbench | `./scripts/dev.sh serve` |
| 启动桌面开发 | `./scripts/dev.sh desktop` |
| 编译 CLI 二进制 | `./scripts/build.sh cli` |
| 编译桌面应用 | `./scripts/build.sh desktop` |
| 品牌化构建 | `bun packages/ellamaka-release/src/cli/build.ts` |
| 类型检查 | `bun typecheck` |
| 上游合并后清理 | `./scripts/check-cleanup.sh --clean` |
| 浏览 API 文档 | `bun ./scripts/scalar-doc.ts` |

详见 `AGENTS.md`。

## 了解更多

| 文档 | 内容 |
|---|---|
| `docs/DESIGN.md` | 架构设计与 WopalSpace 适配 |
| `docs/DESIGN-distribution.md` | 发布流程与产物规格 |
| `docs/BRANDING.md` | 品牌化改造清单 |
| `docs/UPSTREAM-MERGE-LOG.md` | 上游合并历史 |

## 许可证

Fork 自 OpenCode，MIT 协议。详见 `LICENSE`。
