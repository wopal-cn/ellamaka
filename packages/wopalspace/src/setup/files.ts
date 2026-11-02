import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from "node:fs"
import { dirname, join } from "node:path"

/**
 * Atomic, permission-restricted publish for the Home files setup owns.
 * Writes a sibling temp file, flushes it, then renames over the target.
 */
export function writeFileAtomic(file: string, content: string, mode = 0o600): void {
  const directory = dirname(file)
  mkdirSync(directory, { recursive: true })
  const temporary = join(
    directory,
    "." + file.split("/").pop() + "." + process.pid + "." + crypto.randomUUID() + ".tmp",
  )
  try {
    const descriptor = openSync(temporary, "w", mode)
    try {
      writeSync(descriptor, content)
      fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
    if (process.platform !== "win32") chmodSync(temporary, mode)
    renameSync(temporary, file)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}

/** Merge one variable into dotenv text, preserving unrelated lines. */
export function mergeEnvVariable(content: string, name: string, value: string): string {
  const normalized = content.replace(/\n+$/, "")
  const lines = normalized.length === 0 ? [] : normalized.split("\n")
  const matcher = new RegExp("^(\\s*)#?\\s*" + name + "=")
  let found = false
  const updated = lines.map((line) => {
    const match = line.match(matcher)
    if (!match) return line
    found = true
    return (match[1] ?? "") + name + "=" + value
  })
  if (!found) updated.push(name + "=" + value)
  return updated.join("\n") + "\n"
}
