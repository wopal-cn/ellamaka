import { describe, expect } from "bun:test"
import path from "path"
import { Effect, FileSystem, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { NodeFileSystem } from "@effect/platform-node"
import { CrossSpawnSpawner } from "@wopal/ellamaka-core/cross-spawn-spawner"
import { AppFileSystem } from "@wopal/ellamaka-core/filesystem"
import { Config } from "../../src/config/config"
import { InstanceState } from "../../src/effect/instance-state"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Instruction } from "../../src/session/instruction"
import type { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { Global } from "@wopal/ellamaka-core/global"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { provideInstance, provideTmpdirInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestConfig } from "../fixture/config"

const it = testEffect(Layer.mergeAll(CrossSpawnSpawner.defaultLayer, NodeFileSystem.layer))

const configLayer = TestConfig.layer()

const instructionLayer = (global: Partial<Global.Interface>, flags: Partial<RuntimeFlags.Info> = {}) =>
  Instruction.layer.pipe(
    Layer.provide(configLayer),
    Layer.provide(AppFileSystem.defaultLayer),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Global.layerWith(global)),
    Layer.provide(RuntimeFlags.layer(flags)),
  )

const provideInstruction =
  (global: Partial<Global.Interface>, flags?: Partial<RuntimeFlags.Info>) =>
  <A, E, R>(self: Effect.Effect<A, E, R>) =>
    self.pipe(Effect.provide(instructionLayer(global, flags)))

const provideInstructionWopalSpace =
  (global: Partial<Global.Interface>) =>
  <A, E, R>(self: Effect.Effect<A, E, R>) =>
    self.pipe(Effect.provide(instructionLayer(global, { wopalSpace: true, disableClaudeCodePrompt: true })))

const write = (filepath: string, content: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(path.dirname(filepath), { recursive: true })
    yield* fs.writeFileString(filepath, content)
  })

const writeFiles = (dir: string, files: Record<string, string>) =>
  Effect.all(
    Object.entries(files).map(([file, content]) => write(path.join(dir, file), content)),
    { discard: true },
  )

const withFiles = <A, E, R>(files: Record<string, string>, self: (dir: string) => Effect.Effect<A, E, R>) =>
  provideTmpdirInstance((dir) =>
    Effect.gen(function* () {
      yield* writeFiles(dir, files)
      return yield* self(dir).pipe(provideInstruction({ home: dir, config: dir }))
    }),
  )

const tmpWithFiles = (files: Record<string, string>) =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    yield* writeFiles(dir, files)
    return dir
  })

describe("Instruction.layer", () => {
  it.live("builds without WOPAL_SPACE or InstanceRef", () =>
    Effect.scoped(
      Layer.build(
        Instruction.layer.pipe(
          Layer.provide(
            Layer.mock(Config.Service, {
              isWopalSpace: () => InstanceState.context.pipe(Effect.as(false)),
            }),
          ),
          Layer.provide(AppFileSystem.defaultLayer),
          Layer.provide(FetchHttpClient.layer),
          Layer.provide(Global.layerWith({ home: "/tmp", config: "/tmp" })),
          Layer.provide(RuntimeFlags.layer({ wopalSpace: false, disableClaudeCodePrompt: false })),
        ),
      ),
    ).pipe(Effect.asVoid),
  )
})

const visibilityModel = {
  providerID: ProviderID.make("anthropic"),
  modelID: ModelID.make("claude-sonnet-4-20250514"),
}

function userText(text: string, id = "msg_user-text", loaded: string[] = []): MessageV2.WithParts {
  const messageID = MessageID.make(id)
  const sessionID = SessionID.make("session-instruction-visibility")
  return {
    info: {
      id: messageID,
      sessionID,
      role: "user",
      time: { created: 0 },
      agent: "build",
      model: visibilityModel,
    },
    parts: [
      {
        id: PartID.make(`prt_${id}-text`),
        messageID,
        sessionID,
        type: "text",
        text,
        synthetic: true,
        ...(loaded.length > 0 ? { metadata: { loaded } } : {}),
      },
    ],
  }
}

function assistantTool(
  output: string,
  opts: { id?: string; metadata?: Record<string, unknown>; compacted?: boolean } = {},
): MessageV2.WithParts {
  const id = opts.id ?? "msg_tool-output"
  const messageID = MessageID.make(id)
  const sessionID = SessionID.make("session-instruction-visibility")
  return {
    info: {
      id: messageID,
      sessionID,
      role: "assistant",
      parentID: MessageID.make("msg_parent"),
      mode: "build",
      agent: "build",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: visibilityModel.modelID,
      providerID: visibilityModel.providerID,
      time: { created: 0 },
    },
    parts: [
      {
        id: PartID.make(`prt_${id}-tool`),
        messageID,
        sessionID,
        type: "tool",
        callID: `${id}-call`,
        tool: "read",
        state: {
          status: "completed",
          input: {},
          output,
          title: "Read",
          metadata: opts.metadata ?? {},
          time: { start: 0, end: 1, ...(opts.compacted ? { compacted: 1 } : {}) },
        },
      },
    ],
  }
}

function reminder(filepath: string, content: string) {
  return `<system-reminder>\nInstructions from: ${filepath}\n${content}\n</system-reminder>`
}

describe("Instruction.inspect", () => {
  it.live("resolves relative targets from the session directory and honors real directory boundaries", () =>
    Effect.gen(function* () {
      const base = yield* tmpdirScoped()
      const root = path.join(base, "project")
      const other = path.join(base, "project-other")
      yield* writeFiles(root, {
        "sub/AGENTS.md": "# Sub Instructions",
        "sub/file.ts": "const x = 1",
        "sub/nested/file.ts": "const x = 2",
      })
      yield* writeFiles(other, {
        "sub/AGENTS.md": "# Other Instructions",
        "sub/file.ts": "const x = 3",
      })

      yield* Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const inside = yield* svc.inspect({ filepath: "sub/file.ts" })
        expect(inside.files.map((item) => item.filepath)).toEqual([path.join(root, "sub", "AGENTS.md")])
        expect(inside.attach.map((item) => item.content)).toEqual(["# Sub Instructions"])

        const outside = yield* svc.inspect({ filepath: "../project-other/sub/file.ts" })
        expect(outside.files).toEqual([])
        expect(outside.attach).toEqual([])
      }).pipe(provideInstance(root), provideInstruction({ home: root, config: root }))
    }),
  )

  it.live("uses the real target directory for in-project symlinks and does not cross an out-of-project link", () =>
    Effect.gen(function* () {
      const base = yield* tmpdirScoped()
      const root = path.join(base, "project")
      const outside = path.join(base, "outside")
      const fs = yield* FileSystem.FileSystem
      yield* writeFiles(root, {
        "sub/AGENTS.md": "# Parent Rule",
        "sub/nested/AGENTS.md": "# Nested Rule",
        "sub/nested/file.ts": "const x = 1",
      })
      yield* writeFiles(outside, {
        "AGENTS.md": "# Outside Rule",
        "file.ts": "const x = 2",
      })
      yield* fs.symlink(path.join(root, "sub", "nested"), path.join(root, "linked"))
      yield* fs.symlink(outside, path.join(root, "outside-link"))

      yield* Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const linked = yield* svc.inspect({ filepath: "linked/file.ts" })
        expect(linked.files.map((item) => item.filepath)).toEqual([
          path.join(root, "sub", "nested", "AGENTS.md"),
          path.join(root, "sub", "AGENTS.md"),
        ])

        const outsideLink = yield* svc.inspect({ filepath: "outside-link/file.ts" })
        expect(outsideLink.files).toEqual([])
        expect(outsideLink.attach).toEqual([])
      }).pipe(provideInstance(root), provideInstruction({ home: root, config: root }))
    }),
  )

  it.live("resolves a new file through an in-project symlinked parent", () =>
    Effect.gen(function* () {
      const base = yield* tmpdirScoped()
      const root = path.join(base, "project")
      const fs = yield* FileSystem.FileSystem
      yield* writeFiles(root, {
        "sub/AGENTS.md": "# Parent Rule",
        "sub/nested/AGENTS.md": "# Nested Rule",
      })
      yield* fs.symlink(path.join(root, "sub", "nested"), path.join(root, "linked"))

      yield* Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const result = yield* svc.inspect({ filepath: "linked/new/deep/file.ts" })
        expect(result.target).toBe(path.join(root, "sub", "nested", "new", "deep", "file.ts"))
        expect(result.attach.map((item) => item.content)).toEqual(["# Nested Rule", "# Parent Rule"])
      }).pipe(provideInstance(root), provideInstruction({ home: root, config: root }))
    }),
  )

  it.live("requires bound metadata and reloads unbound, incomplete, or truncated text", () =>
    withFiles({ "sub/AGENTS.md": "# Sub Instructions", "sub/file.ts": "const x = 1" }, (dir) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const rule = path.join(dir, "sub", "AGENTS.md")
        const filepath = path.join(dir, "sub", "file.ts")

        const metadataOnly = yield* svc.inspect({
          filepath,
          messages: [assistantTool("done", { metadata: { loaded: [rule] } })],
        })
        expect(metadataOnly.attach.map((item) => item.filepath)).toEqual([rule])

        const unboundBody = yield* svc.inspect({
          filepath,
          messages: [assistantTool(reminder(rule, "# Sub Instructions"))],
        })
        expect(unboundBody.attach.map((item) => item.filepath)).toEqual([rule])

        const summarySpoof = yield* svc.inspect({
          filepath,
          messages: [userText(reminder(rule, "# Fake Summary"))],
        })
        expect(summarySpoof.attach.map((item) => item.filepath)).toEqual([rule])

        const unboundVisibility = yield* svc.inspect({
          filepath,
          visibility: { text: [reminder(rule, "# Sub Instructions")] },
        })
        expect(unboundVisibility.attach.map((item) => item.filepath)).toEqual([rule])

        const metadata = { loaded: [rule] }
        const wrongPath = yield* svc.inspect({
          filepath,
          messages: [
            assistantTool(reminder(rule, "# Sub Instructions"), {
              metadata: { loaded: [path.join(dir, "other", "AGENTS.md")] },
            }),
          ],
        })
        expect(wrongPath.attach.map((item) => item.filepath)).toEqual([rule])

        const visible = yield* svc.inspect({
          filepath,
          messages: [assistantTool(reminder(rule, "# Sub Instructions"), { metadata })],
        })
        expect(visible.attach).toEqual([])
        expect(visible.visible).toEqual([rule])
        expect(visible.status).toBe("visible")

        const compacted = yield* svc.inspect({
          filepath,
          messages: [assistantTool(reminder(rule, "# Sub Instructions"), { metadata, compacted: true })],
        })
        expect(compacted.attach.map((item) => item.filepath)).toEqual([rule])

        const missingBody = yield* svc.inspect({
          filepath,
          messages: [assistantTool(reminder(rule, ""), { metadata })],
        })
        expect(missingBody.attach.map((item) => item.filepath)).toEqual([rule])

        const truncated = yield* svc.inspect({
          filepath,
          messages: [
            assistantTool(reminder(rule, "# Sub Instructions").replace("\n</system-reminder>", ""), { metadata }),
          ],
        })
        expect(truncated.attach.map((item) => item.filepath)).toEqual([rule])

        const clipped = yield* svc.inspect({
          filepath,
          messages: [assistantTool(reminder(rule, "# Sub Instructions"), { metadata })],
          toolOutputMaxChars: 20,
        })
        expect(clipped.attach.map((item) => item.filepath)).toEqual([rule])
      }),
    ),
  )

  it.live("keeps a complete visible rule without detecting later disk changes", () =>
    withFiles({ "sub/AGENTS.md": "# Version 1", "sub/file.ts": "const x = 1" }, (dir) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const rule = path.join(dir, "sub", "AGENTS.md")
        const filepath = path.join(dir, "sub", "file.ts")
        yield* write(rule, "# Version 2")

        const result = yield* svc.inspect({
          filepath,
          messages: [assistantTool(reminder(rule, "# Version 1"), { metadata: { loaded: [rule] } })],
        })
        expect(result.attach).toEqual([])
        expect(result.visible).toEqual([rule])
      }),
    ),
  )

  it.live("observes rule text in synthetic user text and preserves a batch-start visibility snapshot", () =>
    withFiles({ "sub/AGENTS.md": "# Sub Instructions", "sub/file.ts": "const x = 1" }, (dir) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const rule = path.join(dir, "sub", "AGENTS.md")
        const filepath = path.join(dir, "sub", "file.ts")
        const empty = svc.snapshot([])

        const synthetic = yield* svc.inspect({
          filepath,
          messages: [userText(reminder(rule, "# Sub Instructions"), "msg_user-rule", [rule])],
        })
        expect(synthetic.visible).toEqual([rule])

        const afterParallelRead = yield* svc.inspect({
          filepath,
          messages: [assistantTool(reminder(rule, "# Sub Instructions"))],
          visibility: empty,
        })
        expect(afterParallelRead.attach.map((item) => item.filepath)).toEqual([rule])
      }),
    ),
  )

  it.live("reports no additional rules and separates unreadable rule files", () =>
    withFiles(
      { "plain/file.ts": "const x = 1", "broken/AGENTS.md": "# Broken", "broken/file.ts": "const x = 2" },
      (dir) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const svc = yield* Instruction.Service
          const none = yield* svc.inspect({ filepath: "plain/file.ts" })
          expect(none.files).toEqual([])
          expect(none.errors).toEqual([])
          expect(none.status).toBe("none")

          const broken = path.join(dir, "broken", "AGENTS.md")
          yield* fs.chmod(broken, 0)
          const unreadable = yield* svc.inspect({ filepath: "broken/file.ts" })
          yield* fs.chmod(broken, 0o644)
          expect(unreadable.attach).toEqual([])
          expect(unreadable.errors.map((item) => item.filepath)).toEqual([broken])
          expect(unreadable.status).toBe("error")
        }),
    ),
  )

  it.live("excludes its own rule from reads but checks it before modification", () =>
    withFiles({ "sub/AGENTS.md": "# Sub Instructions", "sub/file.ts": "const x = 1" }, (dir) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const rule = path.join(dir, "sub", "AGENTS.md")

        const read = yield* svc.inspect({ filepath: "sub/AGENTS.md" })
        expect(read.files).toEqual([])

        const modify = yield* svc.inspect({ filepath: "sub/AGENTS.md", operation: "modify" })
        expect(modify.files.map((item) => item.filepath)).toEqual([rule])
        expect(modify.attach.map((item) => item.filepath)).toEqual([rule])

        const seen = yield* svc.inspect({
          filepath: "sub/AGENTS.md",
          operation: "modify",
          messages: [assistantTool(reminder(rule, "# Sub Instructions"), { metadata: { loaded: [rule] } })],
        })
        expect(seen.attach).toEqual([])
        expect(seen.visible).toEqual([rule])
      }),
    ),
  )

  it.live("fails modification closed for an unreadable baseline without changing baseline rendering", () =>
    withFiles({ "AGENTS.md": "# Root Instructions", "src/file.ts": "const x = 1" }, (dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const svc = yield* Instruction.Service
        const rule = path.join(dir, "AGENTS.md")

        const readable = yield* svc.inspect({ filepath: "src/file.ts", operation: "modify" })
        expect(readable.errors).toEqual([])
        expect(readable.files).toEqual([])

        yield* fs.chmod(rule, 0)
        const read = yield* svc.inspect({ filepath: "src/file.ts" })
        const modify = yield* svc.inspect({ filepath: "src/file.ts", operation: "modify" })
        const baseline = yield* svc.systemResult()
        yield* fs.chmod(rule, 0o644)

        expect(read.errors).toEqual([])
        expect(modify.errors.map((item) => item.filepath)).toEqual([rule])
        expect(baseline.text).toEqual([])
        expect(baseline.baseline.errors.map((item) => item.filepath)).toEqual([rule])

        const recovered = yield* svc.inspect({
          filepath: "src/file.ts",
          operation: "modify",
          visibility: { text: [], baseline: baseline.baseline },
        })
        expect(recovered.errors.map((item) => item.filepath)).toEqual([rule])
      }),
    ),
  )
})

describe("Instruction.system", () => {
  it.live("loads both project and global AGENTS.md when both exist", () =>
    Effect.gen(function* () {
      const globalTmp = yield* tmpWithFiles({ "AGENTS.md": "# Global Instructions" })
      const projectTmp = yield* tmpWithFiles({ "AGENTS.md": "# Project Instructions" })

      yield* Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const paths = yield* svc.systemPaths()
        expect(paths.has(path.join(projectTmp, "AGENTS.md"))).toBe(true)
        expect(paths.has(path.join(globalTmp, "AGENTS.md"))).toBe(true)

        const rules = yield* svc.system()
        expect(rules).toHaveLength(2)
        expect(rules[0]).toBe(`Instructions from: ${path.join(globalTmp, "AGENTS.md")}\n# Global Instructions`)
        expect(rules[1]).toBe(`Instructions from: ${path.join(projectTmp, "AGENTS.md")}\n# Project Instructions`)
      }).pipe(provideInstance(projectTmp), provideInstruction({ home: globalTmp, config: globalTmp }))
    }),
  )

  it.live("skips project and global CLAUDE.md when Claude Code prompt is disabled", () =>
    Effect.gen(function* () {
      const globalTmp = yield* tmpWithFiles({ ".claude/CLAUDE.md": "# Global Claude" })
      const projectTmp = yield* tmpWithFiles({ "CLAUDE.md": "# Project Claude" })

      yield* Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const paths = yield* svc.systemPaths()
        expect(paths.has(path.join(globalTmp, ".claude", "CLAUDE.md"))).toBe(false)
        expect(paths.has(path.join(projectTmp, "CLAUDE.md"))).toBe(false)
        expect(yield* svc.system()).toEqual([])
      }).pipe(
        provideInstance(projectTmp),
        provideInstruction({ home: globalTmp, config: globalTmp }, { disableClaudeCodePrompt: true }),
      )
    }),
  )

  it.live("skips project and global CLAUDE.md when WopalSpace mode is active", () =>
    Effect.gen(function* () {
      const globalTmp = yield* tmpWithFiles({ ".claude/CLAUDE.md": "# Global Claude" })
      const projectTmp = yield* tmpWithFiles({ "CLAUDE.md": "# Project Claude" })

      yield* Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const paths = yield* svc.systemPaths()
        expect(paths.has(path.join(globalTmp, ".claude", "CLAUDE.md"))).toBe(false)
        expect(paths.has(path.join(projectTmp, "CLAUDE.md"))).toBe(false)
        expect(yield* svc.system()).toEqual([])
      }).pipe(provideInstance(projectTmp), provideInstructionWopalSpace({ home: globalTmp, config: globalTmp }))
    }),
  )
})

describe("Instruction.systemPaths global config", () => {
  it.live("uses Global.Service config AGENTS.md", () =>
    Effect.gen(function* () {
      const globalTmp = yield* tmpWithFiles({ "AGENTS.md": "# Global Instructions" })
      const projectTmp = yield* tmpdirScoped()

      yield* Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const paths = yield* svc.systemPaths()
        expect(paths.has(path.join(globalTmp, "AGENTS.md"))).toBe(true)
      }).pipe(provideInstance(projectTmp), provideInstruction({ home: globalTmp, config: globalTmp }))
    }),
  )
})

describe("Instruction instance-scoped WopalSpace mode", () => {
  it.live("WopalSpace instance skips CLAUDE.md via Config state without env", () =>
    Effect.gen(function* () {
      const globalTmp = yield* tmpWithFiles({ ".claude/CLAUDE.md": "# Global Claude" })
      const projectTmp = yield* tmpWithFiles({ "CLAUDE.md": "# Project Claude" })

      const prevWopal = process.env.WOPAL_SPACE
      const prevRoot = process.env.WOPAL_SPACE_ROOT
      delete process.env.WOPAL_SPACE
      delete process.env.WOPAL_SPACE_ROOT
      try {
        yield* Effect.gen(function* () {
          const svc = yield* Instruction.Service
          const paths = yield* svc.systemPaths()
          expect(paths.has(path.join(globalTmp, ".claude", "CLAUDE.md"))).toBe(false)
          expect(paths.has(path.join(projectTmp, "CLAUDE.md"))).toBe(false)
          expect(yield* svc.system()).toEqual([])
        }).pipe(
          provideInstance(projectTmp),
          Effect.provide(
            Instruction.layer.pipe(
              Layer.provide(TestConfig.layer({ isWopalSpace: () => Effect.succeed(true) })),
              Layer.provide(AppFileSystem.defaultLayer),
              Layer.provide(FetchHttpClient.layer),
              Layer.provide(Global.layerWith({ home: globalTmp, config: globalTmp })),
              Layer.provide(RuntimeFlags.layer({})),
            ),
          ),
        )
      } finally {
        if (prevWopal === undefined) delete process.env.WOPAL_SPACE
        else process.env.WOPAL_SPACE = prevWopal
        if (prevRoot === undefined) delete process.env.WOPAL_SPACE_ROOT
        else process.env.WOPAL_SPACE_ROOT = prevRoot
      }
    }),
  )
})
