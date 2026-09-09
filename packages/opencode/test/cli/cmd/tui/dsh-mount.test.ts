import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { DEFAULT_DSH_RUNTIME_MANIFEST } from "@wopal/ellamaka-cordis/runtime"
import { mountDshIfEnabled } from "@/cli/cmd/tui/dsh-mount"
import { seedDshClosure } from "../../../fixture/dsh-closure"

const CONTAINER_KEY = "__ellamakaDshContainer"

type ToolContainer = {
  get(name: "tools"): {
    execute(exec: unknown): Promise<{ isError: boolean; content?: { type: string; text?: string }[] }>
  }
  get(name: "sessions"): { list(): unknown[] } | undefined
}

const dshHomes: string[] = []

function tmpWopalHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-tui-wopal-"))
  dshHomes.push(dir)
  return dir
}

afterEach(() => {
  delete process.env.ELLAMAKA_DSH
  delete process.env.DSH_HOME
  delete (globalThis as Record<string, unknown>)[CONTAINER_KEY]
  for (const dir of dshHomes.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe("tui dsh mount", () => {
  test("returns undefined when ELLAMAKA_DSH is disabled (kill switch =0)", async () => {
    process.env.ELLAMAKA_DSH = "0"
    const handle = await mountDshIfEnabled({ wopalHome: tmpWopalHome() })
    expect(handle).toBeUndefined()
    expect((globalThis as Record<string, unknown>)[CONTAINER_KEY]).toBeUndefined()
  })

  test("points B-class $DSH_HOME reads at the official-layout home on a ready mount", async () => {
    process.env.ELLAMAKA_DSH = "1"
    const wopalHome = tmpWopalHome()
    seedDshClosure(wopalHome)
    const handle = await mountDshIfEnabled({
      wopalHome,
      logFile: join(wopalHome, "logs", "dsh-plugins.log"),
    })
    expect(handle).toBeDefined()
    // The host sets DSH_HOME=$WOPAL_HOME/dsh/home at process launch; the TUI
    // mount must match so env-reading plugins (e.g. agent presets) land in the
    // DSH home, never fall back to ~/.dsh.
    expect(process.env.DSH_HOME).toBe(join(wopalHome, "dsh", "home"))
    await handle!.dispose()
  })

  test("mounts the tool container and executes grep without a live session", async () => {
    process.env.ELLAMAKA_DSH = "1"
    const wopalHome = tmpWopalHome()
    seedDshClosure(wopalHome)
    const handle = await mountDshIfEnabled({
      wopalHome,
      logFile: join(wopalHome, "logs", "dsh-plugins.log"),
    })
    expect(handle).toBeDefined()

    try {
      const container = (globalThis as Record<string, unknown>)[CONTAINER_KEY] as ToolContainer
      expect(container).toBeDefined()

      const ws = mkdtempSync(join(tmpdir(), "dsh-tui-ws-"))
      for (let i = 0; i < 400; i++) {
        writeFileSync(join(ws, `f${i}.txt`), `needle line ${i}\n`)
      }

      const tools = container.get("tools")
      const facade = { session: { header: { id: `tui-${Date.now()}`, cwd: ws } } }
      const result = await tools.execute({
        callId: "tui-mount-call",
        name: "grep",
        arguments: { pattern: "needle", path: ws },
        signal: new AbortController().signal,
        agent: facade,
      })
      const text = (result.content ?? []).map((b) => b.text ?? "").join("\n")
      expect(result.isError).toBe(false)
      expect(text).toContain("250 of 400")

      const sessions = container.get("sessions")
      expect(sessions?.list() ?? []).toEqual([])
    } finally {
      await handle!.dispose()
    }
  }, 60_000)

  test("dispose clears the global container", async () => {
    process.env.ELLAMAKA_DSH = "1"
    const wopalHome = tmpWopalHome()
    seedDshClosure(wopalHome)
    const handle = await mountDshIfEnabled({
      wopalHome,
      logFile: join(wopalHome, "logs", "dsh-plugins.log"),
    })
    expect(handle).toBeDefined()
    await handle!.dispose()
    expect((globalThis as Record<string, unknown>)[CONTAINER_KEY]).toBeUndefined()
  }, 60_000)

  test("a broken closure degrades instead of crashing the TUI (B-06)", async () => {
    process.env.ELLAMAKA_DSH = "1"
    const wopalHome = tmpWopalHome()
    const anchor = seedDshClosure(wopalHome)
    const closureRoot = dirname(dirname(dirname(dirname(anchor))))
    // Replace the symlinked @deepseek-ai tree (which points at the shared real
    // install) with a self-contained real tree whose @deepseek-ai/dsh package
    // has NO resolvable entry point — so the manager's loader gate (B-06)
    // degrades deterministically. All deps match the manifest's pinned
    // versions so the content check (B-03) passes and the loader gate fires.
    const aiDir = join(closureRoot, "node_modules", "@deepseek-ai")
    rmSync(aiDir, { recursive: true, force: true })
    mkdirSync(aiDir, { recursive: true })
    const manifest = DEFAULT_DSH_RUNTIME_MANIFEST
    for (const [name, version] of Object.entries(manifest.dependencies)) {
      // aiDir IS the @deepseek-ai scope; the scoped name "…/dsh" reduces to "dsh".
      const dir = join(aiDir, name.slice("@deepseek-ai/".length))
      mkdirSync(dir, { recursive: true })
      // dsh deliberately has NO entry point (the broken export).
      const pkg = name === "@deepseek-ai/dsh"
        ? { name, version }
        : { name, version, main: "index.js" }
      writeFileSync(join(dir, "package.json"), JSON.stringify(pkg))
    }
    let handle: unknown
    let error: unknown
    try {
      handle = await mountDshIfEnabled({
        wopalHome,
        logFile: join(wopalHome, "logs", "dsh-plugins.log"),
      })
    } catch (e) {
      error = e
    }
    expect(error).toBeUndefined()
    expect(handle).toBeUndefined()
    expect((globalThis as Record<string, unknown>)[CONTAINER_KEY]).toBeUndefined()
  }, 60_000)
})
