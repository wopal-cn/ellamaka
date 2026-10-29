export type ProcessStateTarget = {
  readonly env: Record<string, string | undefined>
  readonly cwd: () => string
  readonly chdir: (directory: string) => void
}

export type ProcessStateSnapshot = {
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
}

function snapshotEnv(environment: Record<string, string | undefined>) {
  return Object.fromEntries(
    Object.entries(environment)
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .sort(([a], [b]) => a.localeCompare(b)),
  )
}

export function captureProcessState(target: ProcessStateTarget = process): ProcessStateSnapshot {
  return {
    cwd: target.cwd(),
    env: snapshotEnv(target.env),
  }
}

function formatEnv(value: string | undefined) {
  return value === undefined ? "<unset>" : JSON.stringify(value)
}

export function diffProcessState(expected: ProcessStateSnapshot, actual: ProcessStateSnapshot): string[] {
  const changes: string[] = []
  if (actual.cwd !== expected.cwd) changes.push(`cwd: expected ${expected.cwd}, got ${actual.cwd}`)

  const keys = [...new Set([...Object.keys(expected.env), ...Object.keys(actual.env)])].sort()
  for (const key of keys) {
    const before = expected.env[key]
    const after = actual.env[key]
    if (before === after) continue
    changes.push(`env.${key}: expected ${formatEnv(before)}, got ${formatEnv(after)}`)
  }
  return changes
}

export function restoreProcessState(snapshot: ProcessStateSnapshot, target: ProcessStateTarget = process) {
  for (const key of Object.keys(target.env)) {
    if (!(key in snapshot.env)) delete target.env[key]
  }
  for (const [key, value] of Object.entries(snapshot.env)) target.env[key] = value
  if (target.cwd() !== snapshot.cwd) target.chdir(snapshot.cwd)
}

export function assertProcessStateClean(snapshot: ProcessStateSnapshot, target: ProcessStateTarget = process) {
  const changes = diffProcessState(snapshot, captureProcessState(target))
  if (changes.length === 0) return

  restoreProcessState(snapshot, target)
  throw new Error(`[TISO101] test leaked process-global state:\n${changes.map((change) => `- ${change}`).join("\n")}`)
}
