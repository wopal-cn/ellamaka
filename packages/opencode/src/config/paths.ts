export * as ConfigPaths from "./paths"

import path from "path"
import { existsSync } from "fs"
import { Flag } from "@wopal/ellamaka-core/flag/flag"
import { Global } from "@wopal/ellamaka-core/global"
import { unique } from "remeda"
import * as Effect from "effect/Effect"
import { AppFileSystem } from "@wopal/ellamaka-core/filesystem"

export const files = Effect.fn("ConfigPaths.projectFiles")(function* (
  name: string,
  directory: string,
  worktree?: string,
) {
  const afs = yield* AppFileSystem.Service
  return (yield* afs.up({
    targets: [`${name}.jsonc`, `${name}.json`],
    start: directory,
    stop: worktree,
  })).toReversed()
})

export const directories = Effect.fn("ConfigPaths.directories")(function* (directory: string, worktree?: string) {
  const afs = yield* AppFileSystem.Service
  const wopalHome = Global.Path.wopalHome
  return unique([
    Global.Path.config,
    ...(existsSync(Global.Path.opencodeConfig) ? [Global.Path.opencodeConfig] : []),
    ...(!Flag.OPENCODE_DISABLE_PROJECT_CONFIG
      ? yield* afs.up({
          targets: [".opencode"],
          start: directory,
          stop: worktree,
        })
      : []),
    ...(yield* afs.up({
      targets: [".opencode"],
      start: Global.Path.home,
      stop: Global.Path.home,
    })),
    ...(Flag.OPENCODE_CONFIG_DIR ? [Flag.OPENCODE_CONFIG_DIR] : []),
    // ellamaka 全局根（$WOPAL_HOME）。普通模式下追加到列表末尾，使该目录下的
    // agents/commands/plugins/skills 最后加载并覆盖 opencode 生态同名能力；同时
    // 允许该目录下的 opencode.json[c] 配置文件按目录优先级加载（正常布局下不存在）。
    // Wopal-space requests return before this normal-mode path resolver runs.
    // Do not use the process-wide WOPAL_SPACE flag here: one server can host
    // both space and General instances at the same time.
    ...(existsSync(wopalHome) && wopalHome !== Global.Path.config ? [wopalHome] : []),
  ])
})

export function fileInDirectory(dir: string, name: string) {
  return [path.join(dir, `${name}.json`), path.join(dir, `${name}.jsonc`)]
}
