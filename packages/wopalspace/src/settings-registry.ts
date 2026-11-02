import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs"
import { dirname } from "node:path"
import { applyEdits, modify, parse } from "jsonc-parser"

/**
 * Shared protected writer for `$WOPAL_HOME/config/settings.jsonc`.
 *
 * Every owner that persists a settings entry uses this one path so a
 * read → edit → rename race cannot drop another owner's update. The lock
 * covers the read, the JSONC edit and the atomic publish; comments and
 * unknown fields are preserved. Callers validate their own slice through
 * `options.validate`, which sees the reread text while the lock is held.
 */

export class SettingsRegistryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SettingsRegistryError"
  }
}

export class SettingsRegistryBusyError extends SettingsRegistryError {
  constructor(message = "settings.jsonc is locked by another operation") {
    super(message)
    this.name = "SettingsRegistryBusyError"
  }
}

export class SettingsRegistryInvalidError extends SettingsRegistryError {
  constructor(message = "settings.jsonc is not valid JSONC") {
    super(message)
    this.name = "SettingsRegistryInvalidError"
  }
}

export interface UpdateSettingsEntryOptions {
  readonly lockTimeoutMs?: number
  /** Validate the reread document before any edit is applied. Throw to abort untouched. */
  readonly validate?: (text: string) => void
}

export interface SettingsEntryEdit {
  readonly keyPath: readonly string[]
  readonly value: unknown
}

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

function acquire(file: string, timeoutMs: number): number {
  const lock = file + ".lock"
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      return openSync(lock, "wx")
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error
      if (Date.now() > deadline) throw new SettingsRegistryBusyError()
      sleepSync(20)
    }
  }
}

function withLock<T>(file: string, timeoutMs: number, operation: () => T): T {
  const descriptor = acquire(file, timeoutMs)
  try {
    return operation()
  } finally {
    closeSync(descriptor)
    rmSync(file + ".lock", { force: true })
  }
}

function invalidJsonc(text: string): boolean {
  const errors: { error: number; offset: number; length: number }[] = []
  parse(text, errors, { allowTrailingComma: true, disallowComments: false })
  return errors.length > 0
}

/**
 * Atomically set one JSONC entry, rereading the current file inside the lock.
 * Returns false for a no-op (the published bytes are unchanged), true after
 * a successful atomic publish.
 */
export function updateSettingsEntry(
  file: string,
  keyPath: readonly string[],
  value: unknown,
  options: UpdateSettingsEntryOptions = {},
): boolean {
  if (keyPath.length === 0) throw new SettingsRegistryError("An entry path is required")
  return updateSettingsEntries(file, () => [{ keyPath, value }], options)
}

/**
 * Atomically apply a set of JSONC edits computed from the document reread
 * while the registry lock is held. Owners use this for merge semantics that
 * must preserve concurrent changes instead of replacing a stale subtree.
 */
export function updateSettingsEntries(
  file: string,
  plan: (document: unknown) => readonly SettingsEntryEdit[],
  options: UpdateSettingsEntryOptions = {},
): boolean {
  mkdirSync(dirname(file), { recursive: true })
  return withLock(file, options.lockTimeoutMs ?? 5_000, () => {
    const current = existsSync(file) ? readFileSync(file, "utf8") : "{}\n"
    if (invalidJsonc(current)) throw new SettingsRegistryInvalidError()
    options.validate?.(current)
    const document = parse(current, [], { allowTrailingComma: true, disallowComments: false })
    const edits = plan(document)
    let text = current
    for (const edit of edits) {
      if (edit.keyPath.length === 0) throw new SettingsRegistryError("An entry path is required")
      text = applyEdits(
        text,
        modify(text, [...edit.keyPath], edit.value, {
          formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
        }),
      )
    }
    if (text === current) return false
    const temporary = file + "." + process.pid + "." + crypto.randomUUID() + ".tmp"
    try {
      const descriptor = openSync(temporary, "w")
      try {
        writeSync(descriptor, text)
        fsyncSync(descriptor)
      } finally {
        closeSync(descriptor)
      }
      renameSync(temporary, file)
    } catch (error) {
      rmSync(temporary, { force: true })
      throw error
    }
    return true
  })
}
