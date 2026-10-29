import path from "node:path"
import { expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"

const opencodeRoot = path.resolve(import.meta.dir, "../..")
const preload = path.resolve(import.meta.dir, "../preload.ts")

async function runWithRealPreload(source: string) {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "process-state-probe.test.ts")
  await Bun.write(file, source)

  const proc = Bun.spawn(["bun", "test", "--preload", preload, file], {
    cwd: opencodeRoot,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { exitCode, output: stdout + stderr }
}

test("preload process-state guard runs after test-file cleanup hooks", async () => {
  const key = `TISO101_CLEANUP_ORDER_${process.pid}`
  const result = await runWithRealPreload(`
    import { afterEach, test } from "bun:test"
    const key = ${JSON.stringify(key)}
    const before = process.env[key]
    afterEach(() => {
      if (before === undefined) delete process.env[key]
      else process.env[key] = before
    })
    test("mutates state inside the test scope", () => {
      process.env[key] = "dirty"
    })
  `)

  expect(result.exitCode).toBe(0)
  expect(result.output).not.toContain("[TISO101]")
})

test("preload process-state guard reports a leak and restores before the next test", async () => {
  const key = `TISO101_RESTORE_ORDER_${process.pid}`
  const result = await runWithRealPreload(`
    import { expect, test } from "bun:test"
    const key = ${JSON.stringify(key)}
    test("leaks process state", () => {
      process.env[key] = "dirty"
    })
    test("observes the restored baseline", () => {
      expect(process.env[key]).toBeUndefined()
      console.log("TISO101_RESTORED_BASELINE")
    })
  `)

  expect(result.exitCode).not.toBe(0)
  expect(result.output).toContain("[TISO101] test leaked process-global state:")
  expect(result.output).toContain(`env.${key}: expected <unset>, got "dirty"`)
  expect(result.output).toContain("TISO101_RESTORED_BASELINE")
})

test("preload process-state guard reports process state leaked by file afterAll", async () => {
  const key = `TISO101_AFTER_ALL_${process.pid}`
  const result = await runWithRealPreload(`
    import { afterAll, test } from "bun:test"
    const key = ${JSON.stringify(key)}
    test("leaves the test body clean", () => {})
    afterAll(() => {
      process.env[key] = "dirty-after-all"
    })
  `)

  expect(result.exitCode).not.toBe(0)
  expect(result.output).toContain("[TISO101] test leaked process-global state:")
  expect(result.output).toContain(`env.${key}: expected <unset>, got "dirty-after-all"`)
})
