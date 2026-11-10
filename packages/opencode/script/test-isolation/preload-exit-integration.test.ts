import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { resolveTempRoot } from "../../test/lib/temp-root"

const packageRoot = path.resolve(import.meta.dir, "..", "..")

async function testProcess(root: string, filename: string, source: string) {
  const fixture = path.join(root, filename)
  await writeFile(fixture, source)
  return spawnSync(process.execPath, ["test", "--preload", "./test/preload.ts", fixture], {
    cwd: packageRoot,
    env: { ...process.env, TMPDIR: root },
    encoding: "utf8",
    timeout: 15_000,
  })
}

test("preload removes its isolated test Home when the runner exits before afterAll", async () => {
  const root = await mkdtemp(path.join(resolveTempRoot(), "preload-exit-"))
  try {
    const child = await testProcess(root, "early-exit.test.ts", "process.exit(23)\n")
    expect(child.status, child.stderr || child.error?.message).toBe(23)
    const leftover = (await readdir(root)).filter((name) => name.startsWith("opencode-test-data-"))
    expect(leftover).toEqual([])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("next preload reaps only marked test Homes abandoned by SIGKILL", async () => {
  const root = await mkdtemp(path.join(resolveTempRoot(), "preload-kill-"))
  try {
    const killed = await testProcess(root, "killed.test.ts", 'process.kill(process.pid, "SIGKILL")\n')
    expect(killed.signal, killed.stderr || killed.error?.message).toBe("SIGKILL")
    const abandoned = (await readdir(root)).filter((name) => name.startsWith("opencode-test-data-"))
    expect(abandoned).toHaveLength(1)

    // A similarly named directory without an ownership marker is not ours.
    const foreign = path.join(root, "opencode-test-data-999999-foreign")
    await mkdir(foreign)
    await writeFile(path.join(foreign, "keep"), "untouched")

    // A correctly marked Home belonging to a still-running PID is also owned
    // by someone else, even if it is in the same temporary root.
    const activeName = `opencode-test-data-${process.pid}-AbCd12`
    const active = path.join(root, activeName)
    await mkdir(active)
    await writeFile(path.join(active, ".opencode-test-owner"), activeName)

    const next = await testProcess(root, "next.test.ts", "process.exit(23)\n")
    expect(next.status, next.stderr || next.error?.message).toBe(23)
    const homes = (await readdir(root)).filter((name) => name.startsWith("opencode-test-data-"))
    expect(homes.sort()).toEqual([path.basename(foreign), activeName].sort())
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
