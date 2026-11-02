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
import { dirname, join } from "node:path"
import { withFileLock } from "./lock"
import type { SetupState, SetupStateRead, SetupStateStore, SetupStepStatus } from "./types"

export const SETUP_STATE_FILE = "ellamaka.json"
const LEGACY_SETUP_STATE_FILE = "onboarding.json"

const STEP_STATUSES: readonly SetupStepStatus[] = ["pending", "in-progress", "done", "skipped", "failed"]

export function setupStatePath(wopalHome: string): string {
  return join(wopalHome, ".setup", SETUP_STATE_FILE)
}

function legacySetupStatePath(wopalHome: string): string {
  return join(wopalHome, "ellamaka", "state", LEGACY_SETUP_STATE_FILE)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isStepStatus(value: unknown): value is SetupStepStatus {
  return typeof value === "string" && STEP_STATUSES.some((status) => status === value)
}

function readStepMap(value: unknown): Record<string, SetupStepStatus> | undefined {
  if (!isRecord(value)) return undefined
  const steps: Record<string, SetupStepStatus> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (isStepStatus(entry)) steps[key] = entry
  }
  return steps
}

function readErrorMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {}
  const errors: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") errors[key] = entry
  }
  return errors
}

function readNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null
}

/** Strict parse of the persisted document. Returns undefined for a broken file. */
export function parseSetupState(value: unknown): SetupState | undefined {
  if (!isRecord(value) || value.version !== 1) return undefined
  const steps = readStepMap(value.steps)
  if (!steps) return undefined
  const currentStep = typeof value.currentStep === "string" ? value.currentStep : undefined
  if (!currentStep) return undefined
  return {
    version: 1,
    currentStep,
    steps,
    errors: readErrorMap(value.errors),
    completed: value.completed === true,
    startedAt: readNullableString(value.startedAt),
    updatedAt: readNullableString(value.updatedAt),
  }
}

export function emptySetupState(): SetupState {
  return {
    version: 1,
    currentStep: "foundation",
    steps: {},
    errors: {},
    completed: false,
    startedAt: null,
    updatedAt: null,
  }
}

/**
 * Read-only state access. A broken document is reported as corrupt with a
 * diagnostic; it is never renamed, rewritten or removed here.
 */
export function readSetupState(wopalHome: string): SetupStateRead {
  const canonical = setupStatePath(wopalHome)
  const legacy = legacySetupStatePath(wopalHome)
  const path = existsSync(canonical) ? canonical : existsSync(legacy) ? legacy : canonical
  if (!existsSync(path)) return { status: "absent", path: canonical }

  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch (error) {
    return {
      status: "corrupt",
      path,
      diagnostic: "Setup state could not be read: " + (error instanceof Error ? error.message : String(error)),
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { status: "corrupt", path, diagnostic: "Setup state is not valid JSON" }
  }

  const state = parseSetupState(parsed)
  if (!state) {
    return { status: "corrupt", path, diagnostic: "Setup state does not match the expected state schema" }
  }
  return { status: "ok", path, state }
}

/**
 * Atomic publish: write a sibling temp file, flush, then rename over the
 * target. POSIX permissions are restricted because the document records the
 * user's setup journey.
 */
export function writeSetupState(wopalHome: string, state: SetupState): { ok: true } | { ok: false; reason: string } {
  const path = setupStatePath(wopalHome)
  const directory = dirname(path)
  const temporary = join(directory, SETUP_STATE_FILE + "." + process.pid + "." + crypto.randomUUID() + ".tmp")
  try {
    mkdirSync(directory, { recursive: true })
    const descriptor = openSync(temporary, "w", 0o600)
    try {
      writeSync(descriptor, JSON.stringify(state, null, 2) + "\n")
      fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
    renameSync(temporary, path)
    return { ok: true }
  } catch (error) {
    rmSync(temporary, { force: true })
    return {
      ok: false,
      reason: "Failed to write Setup state: " + (error instanceof Error ? error.message : String(error)),
    }
  }
}

export function fileStateStore(wopalHome: string, options: { readonly lockTimeoutMs?: number } = {}): SetupStateStore {
  return {
    async read() {
      return readSetupState(wopalHome)
    },
    async write(state) {
      return writeSetupState(wopalHome, state)
    },
    async update(change) {
      try {
        return withFileLock(
          setupStatePath(wopalHome),
          () => {
            const current = readSetupState(wopalHome)
            const next = change(current)
            if ("error" in next) return { ok: false as const, reason: next.error }
            const written = writeSetupState(wopalHome, next)
            return written.ok ? { ok: true as const, state: next } : written
          },
          { timeoutMs: options.lockTimeoutMs },
        )
      } catch (error) {
        return {
          ok: false,
          reason: "Failed to update Setup state: " + (error instanceof Error ? error.message : String(error)),
        }
      }
    },
  }
}
