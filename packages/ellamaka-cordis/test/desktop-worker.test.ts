import { describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { once } from "node:events"
import { createDesktopWorker, type DesktopWorkerServices } from "../src/plugins/desktop-worker"

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "dsh-desktop-worker-"))
}

/**
 * A throwaway executable "ellamaka" that records its argv to FAKE_OUTPUT,
 * writes a greeting to stdout, a note to stderr, and exits with FAKE_EXIT
 * (default 0). Real installation is never reached — the worker's spawn
 * boundary is what these tests pin.
 */
function fakeEllamaka(script = ""): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-desktop-fake-"))
  const file = join(dir, "fake-ellamaka")
  writeFileSync(
    file,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs')",
      "fs.writeFileSync(process.env.FAKE_OUTPUT, JSON.stringify(process.argv.slice(2)))",
      "process.stdout.write('FAKE-STDOUT\\n')",
      "process.stderr.write('FAKE-STDERR\\n')",
      script,
      "process.exit(Number(process.env.FAKE_EXIT ?? 0))",
    ].join("\n") + "\n",
    "utf-8",
  )
  chmodSync(file, 0o755)
  return file
}

function makeWorker(overrides: { ellamakaBin?: string; dshRoot?: string; profile?: string } = {}): {
  worker: DesktopWorkerServices
  dshRoot: string
  fakeOutput: string
} {
  const bin = overrides.ellamakaBin ?? fakeEllamaka()
  const dshRoot = overrides.dshRoot ?? tempRoot()
  mkdirSync(join(dshRoot, "home", "profiles", overrides.profile ?? "web"), { recursive: true })
  const fakeOutput = join(tempRoot(), "argv.json")
  // The fake records its argv where FAKE_OUTPUT points; the worker forwards
  // process.env to the child, so the test wires the path through the env.
  process.env.FAKE_OUTPUT = fakeOutput
  const worker = createDesktopWorker({ ellamakaBin: bin, dshRoot, profile: overrides.profile })
  return { worker, dshRoot, fakeOutput }
}

describe("createDesktopWorker", () => {
  test("publishes desktopProfiles.current shaped { name, dir } at the territory profile", () => {
    const { worker, dshRoot } = makeWorker()
    expect(worker.desktopProfiles).toEqual({
      current: { name: "web", dir: join(dshRoot, "home", "profiles", "web") },
    })
  })

  test("profile name is configurable and flows into current.dir", () => {
    const { worker, dshRoot } = makeWorker({ profile: "tools" })
    expect(worker.desktopProfiles.current).toEqual({
      name: "tools",
      dir: join(dshRoot, "home", "profiles", "tools"),
    })
  })
})

describe("desktopPnpm.runPlugin spawn shape", () => {
  test("spawns <bin> dsh plugin --profile web add <pkg> and resolves exitCode 0", async () => {
    const { worker, fakeOutput } = makeWorker()
    const handle = worker.desktopPnpm.runPlugin(["add", "dshmarket"], join(fakeOutput, ".."))
    expect(handle.stdout).toBeDefined()
    expect(handle.stderr).toBeDefined()
    expect(typeof handle.cancel).toBe("function")
    const outcome = await handle.done
    expect(outcome).toEqual({ exitCode: 0, signal: null })
    expect(JSON.parse(readFileSync(fakeOutput, "utf-8"))).toEqual([
      "dsh",
      "plugin",
      "--profile",
      "web",
      "add",
      "dshmarket",
    ])
  })

  test("spawns --profile <name> for a configured profile", async () => {
    const { worker, fakeOutput } = makeWorker({ profile: "tools" })
    const handle = worker.desktopPnpm.runPlugin(["remove", "dshmarket"], ".")
    await handle.done
    expect(JSON.parse(readFileSync(fakeOutput, "utf-8"))).toEqual([
      "dsh",
      "plugin",
      "--profile",
      "tools",
      "remove",
      "dshmarket",
    ])
  })

  test("remove and install verbs pass through verbatim", async () => {
    const { worker, fakeOutput } = makeWorker()
    const remove = worker.desktopPnpm.runPlugin(["remove", "dshmarket"], ".")
    await remove.done
    expect(JSON.parse(readFileSync(fakeOutput, "utf-8"))).toEqual([
      "dsh",
      "plugin",
      "--profile",
      "web",
      "remove",
      "dshmarket",
    ])
    const install = worker.desktopPnpm.runPlugin(["install"], ".")
    await install.done
    expect(JSON.parse(readFileSync(fakeOutput, "utf-8"))).toEqual([
      "dsh",
      "plugin",
      "--profile",
      "web",
      "install",
    ])
  })
})

describe("pnpm flag stripping", () => {
  test("strips pnpm flags after the verb (add --force --config.* --reporter=ndjson)", async () => {
    const { worker, fakeOutput } = makeWorker()
    const handle = worker.desktopPnpm.runPlugin(
      ["add", "--force", "--config.minimumReleaseAge=0", "--reporter=ndjson", "dshmarket"],
      ".",
    )
    await handle.done
    expect(JSON.parse(readFileSync(fakeOutput, "utf-8"))).toEqual([
      "dsh",
      "plugin",
      "--profile",
      "web",
      "add",
      "dshmarket",
    ])
  })

  test("strips pnpm flags before the verb (market reinstall shape)", async () => {
    const { worker, fakeOutput } = makeWorker()
    const handle = worker.desktopPnpm.runPlugin(
      ["--no-frozen-lockfile", "--config.minimumReleaseAge=0", "install"],
      ".",
    )
    await handle.done
    expect(JSON.parse(readFileSync(fakeOutput, "utf-8"))).toEqual([
      "dsh",
      "plugin",
      "--profile",
      "web",
      "install",
    ])
  })

  test("strips the workspace flag -w", async () => {
    const { worker, fakeOutput } = makeWorker()
    const handle = worker.desktopPnpm.runPlugin(["add", "-w", "dshmarket"], ".")
    await handle.done
    expect(JSON.parse(readFileSync(fakeOutput, "utf-8"))).toEqual([
      "dsh",
      "plugin",
      "--profile",
      "web",
      "add",
      "dshmarket",
    ])
  })
})

describe("failure and isolation semantics", () => {
  test("unknown verbs pass through and surface a non-zero exitCode", async () => {
    const bin = fakeEllamaka()
    const { worker, fakeOutput } = makeWorker({ ellamakaBin: bin })
    process.env.FAKE_EXIT = "1"
    try {
      const handle = worker.desktopPnpm.runPlugin(["unknown-verb"], ".")
      const outcome = await handle.done
      expect(outcome.exitCode).toBe(1)
      expect(JSON.parse(readFileSync(fakeOutput, "utf-8"))).toEqual([
        "dsh",
        "plugin",
        "--profile",
        "web",
        "unknown-verb",
      ])
    } finally {
      delete process.env.FAKE_EXIT
    }
  })

  test("a missing ellamaka binary resolves exitCode 127 with a locating stderr", async () => {
    const missing = join(tempRoot(), "no-such-ellamaka")
    const { worker } = makeWorker({ ellamakaBin: missing })
    const handle = worker.desktopPnpm.runPlugin(["add", "dshmarket"], ".")
    const chunks: string[] = []
    handle.stderr.on("data", (chunk: Buffer | string) => chunks.push(chunk.toString()))
    const outcome = await handle.done
    expect(outcome.exitCode).toBe(127)
    expect(chunks.join("")).toContain("no-such-ellamaka")
  })

  test("a crashing child resolves its non-zero exitCode without disturbing the host", async () => {
    const bin = fakeEllamaka("process.stderr.write('BOOM\\n')\n")
    const { worker } = makeWorker({ ellamakaBin: bin })
    process.env.FAKE_EXIT = "42"
    try {
      const handle = worker.desktopPnpm.runPlugin(["add", "dshmarket"], ".")
      const outcome = await handle.done
      expect(outcome.exitCode).toBe(42)
    } finally {
      delete process.env.FAKE_EXIT
    }
  })

  test("exposes child stdout/stderr as readable streams", async () => {
    const { worker } = makeWorker()
    const handle = worker.desktopPnpm.runPlugin(["add", "dshmarket"], ".")
    const outChunks: string[] = []
    const errChunks: string[] = []
    handle.stdout.on("data", (chunk: Buffer | string) => outChunks.push(chunk.toString()))
    handle.stderr.on("data", (chunk: Buffer | string) => errChunks.push(chunk.toString()))
    await handle.done
    expect(outChunks.join("")).toContain("FAKE-STDOUT")
    expect(errChunks.join("")).toContain("FAKE-STDERR")
  })
})

describe("cancellation", () => {
  test("aborting the signal kills the process group and resolves { exitCode: null, signal: 'SIGTERM' }", async () => {
    const bin = fakeEllamaka("setTimeout(() => {}, 30000)")
    const { worker } = makeWorker({ ellamakaBin: bin })
    const ac = new AbortController()
    const handle = worker.desktopPnpm.runPlugin(["install"], ".", ac.signal)
    await once(handle.stdout, "data")
    ac.abort()
    const outcome = await handle.done
    expect(outcome.exitCode).toBeNull()
    expect(outcome.signal).toBe("SIGTERM")
  })

  test("cancel() kills the process group and resolves { exitCode: null, signal: 'SIGTERM' }", async () => {
    const bin = fakeEllamaka("setTimeout(() => {}, 30000)")
    const { worker } = makeWorker({ ellamakaBin: bin })
    const handle = worker.desktopPnpm.runPlugin(["install"], ".")
    await once(handle.stdout, "data")
    handle.cancel()
    const outcome = await handle.done
    expect(outcome.exitCode).toBeNull()
    expect(outcome.signal).toBe("SIGTERM")
  })
})