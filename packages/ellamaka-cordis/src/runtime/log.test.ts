import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createDshLogger, createDshLogWriter } from "./log"

const homes: string[] = []

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

function captureStderr(run: () => void) {
  const original = process.stderr.write
  const output: string[] = []
  Reflect.set(process.stderr, "write", (chunk: string) => {
    output.push(chunk)
    return true
  })
  try {
    run()
  } finally {
    Reflect.set(process.stderr, "write", original)
  }
  return output.join("")
}

test("writes runtime diagnostics to the dedicated file without a terminal mirror by default", () => {
  const home = mkdtempSync(join(tmpdir(), "ellamaka-dsh-log-"))
  homes.push(home)
  const logFile = join(home, "logs", "dsh-runtime.log")

  const terminal = captureStderr(() => {
    createDshLogger({ logFile }).info("dsh.stage.inspect", { status: "hit" })
  })

  expect(terminal).toBe("")
  expect(readFileSync(logFile, "utf8")).toContain("dsh.stage.inspect status=hit")
})

test("mirrors runtime diagnostics only when the caller explicitly asks to print logs", () => {
  const home = mkdtempSync(join(tmpdir(), "ellamaka-dsh-log-"))
  homes.push(home)
  const logFile = join(home, "logs", "dsh-runtime.log")

  const terminal = captureStderr(() => {
    createDshLogger({ logFile, print: true }).warn("dsh.stage.inspect", { status: "miss" })
  })

  expect(terminal).toContain("dsh.stage.inspect status=miss")
  expect(readFileSync(logFile, "utf8")).toContain("dsh.stage.inspect status=miss")
})

test("bounds a noisy dsh log and summarizes repeated records", () => {
  const home = mkdtempSync(join(tmpdir(), "ellamaka-dsh-log-"))
  homes.push(home)
  const logFile = join(home, "logs", "dsh-plugins.log")
  let now = 0
  const write = createDshLogWriter({
    logFile,
    maxBytes: 100,
    backupCount: 2,
    suppressForMs: 1_000,
    now: () => now,
  })

  write("same failure\\n")
  now += 1
  write("same failure\\n")
  now += 1
  write("same failure\\n")
  now += 1
  write("next record\\n")
  write("another large record\\n")
  write("and one more record\\n")

  const current = readFileSync(logFile, "utf8")
  const rotated = readFileSync(`${logFile}.1`, "utf8")
  expect(current.length).toBeLessThanOrEqual(100)
  expect(rotated).toContain("suppressed 2 repeated dsh log records")
  expect(rotated).toContain("next record")
})

test("suppresses records that differ only by timestamp without escalating their severity", () => {
  const home = mkdtempSync(join(tmpdir(), "ellamaka-dsh-log-"))
  homes.push(home)
  const logFile = join(home, "logs", "dsh-plugins.log")
  let now = 0
  const write = createDshLogWriter({
    logFile,
    suppressForMs: 1_000,
    now: () => now,
  })

  write("2026-09-15T09:00:00 [DEBUG] [dsh-adapter] tool outcome rejected tool=edit reason=read-required\n")
  now += 1
  write("2026-09-15T09:00:01 [DEBUG] [dsh-adapter] tool outcome rejected tool=edit reason=read-required\n")
  now += 1
  write("2026-09-15T09:00:02 [DEBUG] [dsh-adapter] tool outcome rejected tool=edit reason=read-required\n")
  now += 1
  write("2026-09-15T09:00:03 [INFO] [dsh] another record\n")

  const contents = readFileSync(logFile, "utf8")
  expect(contents.match(/tool outcome rejected/g)?.length).toBe(1)
  expect(contents).toContain("[DEBUG] [dsh] suppressed 2 repeated dsh log records")
  expect(contents).not.toContain("[WARN] [dsh] suppressed")
})

test("reports an unwritable DSH log destination only once", () => {
  const home = mkdtempSync(join(tmpdir(), "ellamaka-dsh-log-"))
  homes.push(home)
  const blocked = join(home, "not-a-directory")
  writeFileSync(blocked, "file")

  const terminal = captureStderr(() => {
    const log = createDshLogger({ logFile: join(blocked, "dsh-runtime.log") })
    log.warn("first failed write")
    log.error("second failed write")
  })

  expect(terminal.match(/\[dsh\] log write failed/g)?.length).toBe(1)
})
