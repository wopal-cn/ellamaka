export type MockLeak = {
  file: string
  module: string
}

const MOCK_CALL = /mock\.module\(\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`)/
const MOCK_CALL_ALL = /mock\.module\(/g
const AFTER_ALL_CALL = /afterAll\(/g

/** A template literal with interpolation is not a statically known module id. */
function isStaticId(id: string | undefined): id is string {
  return id !== undefined && !id.includes("${")
}

/** Index just past the parenthesis that closes the call opened at index `start`. */
function skipBalanced(source: string, start: number) {
  const open = source.indexOf("(", start)
  if (open === -1) return -1
  let depth = 0
  let quote: string | null = null
  for (let index = open; index < source.length; index += 1) {
    const char = source[index]
    if (quote) {
      if (char === "\\") {
        index += 1
        continue
      }
      if (char === quote) quote = null
      continue
    }
    if (char === String.fromCharCode(34) || char === String.fromCharCode(39) || char === String.fromCharCode(96)) {
      quote = char
      continue
    }
    if (char === "(") depth += 1
    if (char === ")") {
      depth -= 1
      if (depth === 0) return index + 1
    }
  }
  return -1
}

function targetOf(match: RegExpMatchArray) {
  return match[1] ?? match[2] ?? match[3]
}

/**
 * Targets restored inside afterAll callbacks only.
 *
 * Scanning from the first afterAll to end-of-file would count any later
 * mock.module as restored, so the callback body must be bounded.
 */
export function collectRestoredTargets(source: string) {
  const restored = new Set<string>()
  for (const match of source.matchAll(AFTER_ALL_CALL)) {
    const bodyEnd = skipBalanced(source, match.index ?? 0)
    if (bodyEnd === -1) continue
    const body = source.slice(match.index, bodyEnd)
    for (const call of body.matchAll(new RegExp(MOCK_CALL.source, "g"))) {
      const target = targetOf(call)
      if (isStaticId(target)) restored.add(target)
    }
  }
  return restored
}

/**
 * Every module mock must be undone, otherwise later files in the same process
 * observe the fake. Bun cannot un-mock, so a file restores the real namespace
 * by calling mock.module() again in afterAll. Targets whose id cannot be read
 * statically are reported as leaks so the audit fails closed.
 */
export function findUnrestoredMocksIn(file: string, source: string): MockLeak[] {
  const calls = [...source.matchAll(MOCK_CALL_ALL)].length
  if (calls === 0) return []
  const leaks: MockLeak[] = []
  const mocked: string[] = []
  for (const call of source.matchAll(new RegExp(MOCK_CALL.source, "g"))) {
    const target = targetOf(call)
    mocked.push(isStaticId(target) ? target : "<dynamic>")
  }
  if (mocked.length !== calls || mocked.includes("<dynamic>")) leaks.push({ file, module: "<dynamic>" })
  const restored = collectRestoredTargets(source)
  for (const module of new Set(mocked)) {
    if (module === "<dynamic>") continue
    if (!restored.has(module)) leaks.push({ file, module })
  }
  return leaks
}
