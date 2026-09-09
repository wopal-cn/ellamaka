---
name: ellamaka build package
description: Branding constants, WopalSpace detection, installation guard, and branded CLI build for the ellamaka fork
---

# Agent Development Rules

## 1. Canonical References

- Parent Rules: `../../AGENTS.md`
- Branding Design: `../../docs/BRANDING.md`
- Project Design: `../../docs/DESIGN.md`

## 2. Architecture and Directories

此包负责 ellamaka 的品牌标识注入和构建。上游文件通过 `import { BINARY_NAME } from "@ellamaka/build/branding"` 引用品牌常量，不在源码中硬编码品牌值。

| 文件 | 职责 |
|------|------|
| `branding.ts` | 品牌常量（BINARY_NAME、CHANNEL_*），修改后需 `bun packages/ellamaka-release/src/cli/build.ts` 重新构建 |
| `detect.ts` | WopalSpace 自动检测：从 cwd 向上查找 `.wopal/.git` worktree marker |
| `is-wopal-install.ts` | 安装路径判断：检查 `process.execPath` 是否在 `WOPAL_HOME/bin/` 下 |
| `logo.ts` | ellamaka ASCII 字模 |
| `test/` | 包级测试 |

> 构建/发布工具（品牌化 CLI 构建、release identity、manifest、Gitee、cleanup、upstream lock、legacy inventory）已迁移至 `../ellamaka-release`，见 `../ellamaka-release/AGENTS.md`。

## 3. Development Commands

| 场景 | 命令 |
|------|------|
| Test | `bun test` from `packages/ellamaka-brand` |
| Build | `bun packages/ellamaka-release/src/cli/build.ts --web-ui ellamaka-app` |

## 4. Implementation Rules

- `branding.ts` 是品牌常量唯一真相源；所有品牌值变更只改此文件。
- `detect.ts` 通过检测 `.wopal/.git` 是否为普通文件（worktree marker）判断 WopalSpace，停止条件为 home 目录或文件系统根。
- `isWopalInstall()` 使用 `WOPAL_HOME` 环境变量（支持 `~/` 前缀），路径判断替代 channel 名前缀判断。
- `build.ts` 是唯一构建入口，禁止直接运行上游构建脚本；构建参数通过 `--arch` 和 `--web-ui` 控制。
- `--web-ui ellamaka-app` 嵌入 ellamaka Web UI，`--web-ui app` 嵌入上游 app 基线，`--web-ui none` 跳过 Web UI 嵌入。
- 新增品牌常量或修改 channel 命名后，检查 `../../docs/BRANDING.md` 是否需要同步更新。

## 5. Testing

- 代码变更遵循 TDD：先写能失败的测试，再实现代码使其通过。
- 从 `packages/ellamaka-brand` 运行 `bun test`。
- 修改 `branding.ts` 后运行 `branding.test.ts`；修改 `detect.ts` 后运行 `detect.test.ts`；修改 `is-wopal-install.ts` 后运行 `is-wopal-install.test.ts`。

## 6. User-Supplied Rules

（暂无）
