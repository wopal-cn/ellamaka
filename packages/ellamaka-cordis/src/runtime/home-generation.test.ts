import { describe, expect, it } from "bun:test"
import { readFileSync, readdirSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"
import {
  ABSENT_INPUT,
  DSH_FS_MUTATION_EXEMPTIONS,
  DSH_HOME_GENERATION_INPUTS,
  FS_MUTATION_APIS,
  FS_READ_ONLY_APIS,
  HomeGenerationError,
  computeGuardedFingerprint,
  computePublishedFrontier,
  evaluateCurrentGeneration,
  parseClosureGeneration,
  type CommittedRelease,
} from "./home-generation.js"

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const repositoryRoot = resolve(packageRoot, "../..")

function release(overrides: Partial<CommittedRelease>): CommittedRelease {
  return {
    product: "ellamaka-cli",
    tag: "ellamaka-cli-v2.0.9-rc.1",
    commit: "0".repeat(40),
    generation: 3,
    fingerprint: "sha256:" + "a".repeat(64),
    engineVersion: "0.2.0-rc.2",
    ...overrides,
  }
}

describe("computeGuardedFingerprint", () => {
  it("is stable regardless of input key order", () => {
    const left = computeGuardedFingerprint({
      dshVersion: "0.2.0-rc.2",
      inputs: { "b.ts": "two", "a.ts": "one" },
    })
    const right = computeGuardedFingerprint({
      dshVersion: "0.2.0-rc.2",
      inputs: { "a.ts": "one", "b.ts": "two" },
    })
    expect(left).toBe(right)
    expect(left).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it("changes when the pinned engine version changes", () => {
    const inputs = { "a.ts": "one" }
    expect(computeGuardedFingerprint({ dshVersion: "0.2.0-rc.2", inputs })).not.toBe(
      computeGuardedFingerprint({ dshVersion: "0.2.0-rc.3", inputs }),
    )
  })

  it("changes when a Home generation input changes", () => {
    expect(computeGuardedFingerprint({ dshVersion: "0.2.0-rc.2", inputs: { "a.ts": "one" } })).not.toBe(
      computeGuardedFingerprint({ dshVersion: "0.2.0-rc.2", inputs: { "a.ts": "two" } }),
    )
  })

  it("distinguishes an absent historical input from any present content", () => {
    const absent = computeGuardedFingerprint({ dshVersion: "0.2.0-rc.2", inputs: { "a.ts": ABSENT_INPUT } })
    const empty = computeGuardedFingerprint({ dshVersion: "0.2.0-rc.2", inputs: { "a.ts": "" } })
    expect(absent).not.toBe(empty)
  })
})

describe("parseClosureGeneration", () => {
  it("reads the shipped constant", () => {
    expect(parseClosureGeneration("export const DSH_CLOSURE_VERSION = 3\n")).toBe(3)
  })

  it("returns null for a release that predates the constant", () => {
    expect(parseClosureGeneration("export const OTHER = 1\n")).toBeNull()
  })

  it("rejects a non-positive generation", () => {
    expect(() => parseClosureGeneration("export const DSH_CLOSURE_VERSION = 0\n")).toThrow(HomeGenerationError)
  })
})

describe("computePublishedFrontier", () => {
  it("fails closed when no committed release is confirmed", () => {
    expect(() => computePublishedFrontier([])).toThrow(HomeGenerationError)
  })

  it("treats a release without the constant as generation 0 (bootstrap)", () => {
    const frontier = computePublishedFrontier([release({ generation: 0, fingerprint: "sha256:" + "b".repeat(64) })])
    expect(frontier.generation).toBe(0)
  })

  it("takes the maximum generation across both products", () => {
    const frontier = computePublishedFrontier([
      release({ product: "ellamaka-cli", generation: 2, fingerprint: "sha256:" + "c".repeat(64) }),
      release({ product: "ellamaka-desktop", generation: 3, fingerprint: "sha256:" + "a".repeat(64) }),
    ])
    expect(frontier.generation).toBe(3)
    expect(frontier.fingerprints).toEqual(["sha256:" + "a".repeat(64)])
  })

  it("rejects one positive generation published with two different fingerprints", () => {
    expect(() =>
      computePublishedFrontier([
        release({ product: "ellamaka-cli" }),
        release({
          product: "ellamaka-desktop",
          tag: "ellamaka-desktop-v2.0.9-beta.1",
          fingerprint: "sha256:" + "b".repeat(64),
        }),
      ]),
    ).toThrow(/DSH_HOME_GENERATION_CONFLICT/)
  })

  it("does not compare fingerprints at generation 0", () => {
    const frontier = computePublishedFrontier([
      release({ generation: 0, fingerprint: "sha256:" + "b".repeat(64) }),
      release({ generation: 0, fingerprint: "sha256:" + "c".repeat(64) }),
    ])
    expect(frontier.generation).toBe(0)
  })
})

describe("evaluateCurrentGeneration", () => {
  const frontier3 = computePublishedFrontier([release({})])

  it("accepts a matching fingerprint at the same generation", () => {
    const verdict = evaluateCurrentGeneration({
      frontier: frontier3,
      generation: 3,
      fingerprint: "sha256:" + "a".repeat(64),
    })
    expect(verdict.status).toBe("aligned")
  })

  it("rejects a pushed engine version with an unchanged generation", () => {
    expect(() =>
      evaluateCurrentGeneration({ frontier: frontier3, generation: 3, fingerprint: "sha256:" + "d".repeat(64) }),
    ).toThrow(/DSH_HOME_GENERATION_STALE/)
  })

  it("accepts a pushed engine version once the generation is bumped", () => {
    const verdict = evaluateCurrentGeneration({
      frontier: frontier3,
      generation: 4,
      fingerprint: "sha256:" + "d".repeat(64),
    })
    expect(verdict.status).toBe("bumped")
  })

  it("rejects a generation that went backwards", () => {
    expect(() =>
      evaluateCurrentGeneration({ frontier: frontier3, generation: 2, fingerprint: "sha256:" + "a".repeat(64) }),
    ).toThrow(/DSH_HOME_GENERATION_STALE/)
  })

  it("bootstraps from a generation-0 frontier", () => {
    const frontier0 = computePublishedFrontier([release({ generation: 0 })])
    const verdict = evaluateCurrentGeneration({
      frontier: frontier0,
      generation: 3,
      fingerprint: "sha256:" + "e".repeat(64),
    })
    expect(verdict.status).toBe("bootstrap")
  })
})

// ---------------------------------------------------------------------------
// FS mutation drift gate
//
// This is a deliberate bounded check: it classifies direct `fs` call sites in
// production TypeScript. It does NOT claim cross-module dataflow inference —
// indirect payload sources are covered by the explicit generation-input
// contract instead.
// ---------------------------------------------------------------------------

const FS_MODULES = new Set(["node:fs", "fs", "node:fs/promises", "fs/promises"])

type FsValue =
  | { kind: "namespace"; promises: boolean }
  | { kind: "api"; api: string }
  | { kind: "unknown"; api: string }

interface FsCallSite {
  api: string
  line: number
}

interface SourceScan {
  mutations: FsCallSite[]
  unknown: FsCallSite[]
}

function createFsResolver(sourceFile: ts.SourceFile, source: string) {
  const host: ts.CompilerHost = {
    getSourceFile: (name) => (name === sourceFile.fileName ? sourceFile : undefined),
    getDefaultLibFileName: () => "lib.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => dirname(sourceFile.fileName),
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (name) => name === sourceFile.fileName,
    readFile: (name) => (name === sourceFile.fileName ? source : undefined),
  }
  const program = ts.createProgram(
    [sourceFile.fileName],
    {
      target: ts.ScriptTarget.Latest,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      noLib: true,
    },
    host,
  )
  const checker = program.getTypeChecker()
  const cache = new Map<ts.Declaration, FsValue | null>()

  const importModule = (declaration: ts.Declaration): string | null => {
    let node: ts.Node | undefined = declaration
    while (node && !ts.isImportDeclaration(node)) node = node.parent
    if (!node) return null
    const module = node.moduleSpecifier
    return ts.isStringLiteral(module) && FS_MODULES.has(module.text) ? module.text : null
  }

  const staticName = (name: ts.PropertyName | undefined): string | null => {
    if (!name) return null
    if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text
    if (ts.isNumericLiteral(name)) return name.text
    if (ts.isComputedPropertyName(name)) {
      const expression = name.expression
      if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text
      if (ts.isNumericLiteral(expression)) return expression.text
    }
    return null
  }

  const property = (target: FsValue, name: string | null): FsValue => {
    if (target.kind === "unknown") return target
    if (name === null) return { kind: "unknown", api: "(dynamic)" }
    if (target.kind === "namespace") {
      if (name === "promises" && !target.promises) return { kind: "namespace", promises: true }
      return { kind: "api", api: name }
    }
    return { kind: "unknown", api: target.api }
  }

  const unwrap = (expression: ts.Expression): ts.Expression => {
    let current = expression
    while (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isSatisfiesExpression(current)
    ) {
      current = current.expression
    }
    return current
  }

  const resolveBinding = (element: ts.BindingElement): FsValue | null => {
    let root: ts.Node = element
    let pattern: ts.Node = element.parent
    const keys: (string | null)[] = []
    while (ts.isObjectBindingPattern(pattern)) {
      keys.push(staticName(element.propertyName ?? element.name))
      root = pattern.parent
      if (!ts.isBindingElement(root)) break
      element = root
      pattern = root.parent
    }
    if (!ts.isVariableDeclaration(root) || root.initializer === undefined) return null
    if (!ts.isVariableDeclarationList(root.parent)) return null
    const initialized = resolveExpression(root.initializer)
    if (!initialized) return null
    if (hasLaterWrite(element) || hasLaterWrite(root))
      return initialized.kind === "namespace"
        ? { kind: "unknown", api: "(namespace)" }
        : { kind: "unknown", api: initialized.api }
    let value = initialized
    if (!value) return null
    for (const key of keys.reverse()) value = property(value, key)
    return value
  }

  /** A symbol with another assigned value is no longer a known static alias. */
  const hasLaterWrite = (declaration: ts.Declaration): boolean => {
    const name = ts.isBindingElement(declaration)
      ? declaration.name
      : ts.isVariableDeclaration(declaration)
        ? declaration.name
        : undefined
    if (!name || !ts.isIdentifier(name)) return false
    const symbol = checker.getSymbolAtLocation(name)
    if (!symbol) return false
    let written = false
    const inspect = (node: ts.Node): void => {
      if (written) return
      if (node !== declaration && ts.isIdentifier(node) && checker.getSymbolAtLocation(node) === symbol) {
        const statement = node.parent
        if (
          (ts.isAssignmentExpression(statement) && statement.left === node) ||
          ((ts.isPrefixUnaryExpression(statement) || ts.isPostfixUnaryExpression(statement)) &&
            statement.operator !== ts.SyntaxKind.ExclamationToken) ||
          (ts.isVariableDeclaration(statement) && statement.name === node && statement !== declaration)
        )
          written = true
      }
      ts.forEachChild(node, inspect)
    }
    inspect(sourceFile)
    return written
  }

  const resolveDeclaration = (declaration: ts.Declaration): FsValue | null => {
    if (cache.has(declaration)) return cache.get(declaration) ?? null
    cache.set(declaration, null)
    let value: FsValue | null = null
    if (ts.isImportClause(declaration) || ts.isNamespaceImport(declaration)) {
      const module = importModule(declaration)
      if (module) value = { kind: "namespace", promises: module.endsWith("/promises") }
    } else if (ts.isImportSpecifier(declaration)) {
      const module = importModule(declaration)
      if (module) {
        const imported = declaration.propertyName?.text ?? declaration.name.text
        value = imported === "promises" ? { kind: "namespace", promises: true } : { kind: "api", api: imported }
      }
    } else if (ts.isVariableDeclaration(declaration)) {
      const list = declaration.parent
      // An alias initialized from a known fs binding is always a mutation
      // candidate, even when `let`/`var` allows a later reassignment. Treating
      // the initializer conservatively avoids a silent gap without predicting
      // control flow or widening this into whole-program dataflow analysis.
      if (ts.isVariableDeclarationList(list) && declaration.initializer) {
        const initialized = resolveExpression(declaration.initializer)
        if (initialized)
          value = hasLaterWrite(declaration)
            ? { kind: "unknown", api: initialized.kind === "namespace" ? "(namespace)" : initialized.api }
            : initialized
      }
    } else if (ts.isBindingElement(declaration)) {
      value = resolveBinding(declaration)
    }
    cache.set(declaration, value)
    return value
  }

  const resolveExpression = (raw: ts.Expression): FsValue | null => {
    const expression = unwrap(raw)
    if (ts.isIdentifier(expression)) {
      const symbol = checker.getSymbolAtLocation(expression)
      const declaration = symbol?.declarations?.[0]
      return declaration ? resolveDeclaration(declaration) : null
    }
    if (ts.isPropertyAccessExpression(expression)) {
      const target = resolveExpression(expression.expression)
      return target ? property(target, expression.name.text) : null
    }
    if (ts.isElementAccessExpression(expression)) {
      const target = resolveExpression(expression.expression)
      if (!target) return null
      return property(target, staticName(expression.argumentExpression))
    }
    return null
  }

  return resolveExpression
}

function scanSource(fileName: string, source: string): SourceScan {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const scan: SourceScan = { mutations: [], unknown: [] }
  const resolveFs = createFsResolver(sourceFile, source)

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const value = resolveFs(node.expression)
      if (value !== null) {
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
        if (value.kind === "unknown") {
          scan.unknown.push({ api: value.api, line })
        } else if (value.kind === "namespace") {
          scan.unknown.push({ api: "(namespace)", line })
        } else if (FS_MUTATION_APIS.has(value.api)) {
          scan.mutations.push({ api: value.api, line })
        } else if (!FS_READ_ONLY_APIS.has(value.api)) {
          scan.unknown.push({ api: value.api, line })
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return scan
}

function productionSources(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "fixtures") continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...productionSources(full))
      continue
    }
    if (!entry.name.endsWith(".ts")) continue
    if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".d.ts")) continue
    files.push(full)
  }
  return files
}

describe("fs mutation drift gate", () => {
  it("flags a direct named import", () => {
    const scan = scanSource("a.ts", 'import { writeFileSync } from "node:fs"\nwriteFileSync("x", "y")\n')
    expect(scan.mutations).toEqual([{ api: "writeFileSync", line: 2 }])
  })

  it("flags an aliased named import", () => {
    const scan = scanSource("a.ts", 'import { writeFileSync as write } from "node:fs"\nwrite("x", "y")\n')
    expect(scan.mutations.map((c) => c.api)).toEqual(["writeFileSync"])
  })

  it("flags namespace and default imports, including fs.promises", () => {
    const namespace = scanSource("a.ts", 'import * as fs from "node:fs"\nfs.mkdirSync("x")\n')
    expect(namespace.mutations.map((c) => c.api)).toEqual(["mkdirSync"])
    const fallback = scanSource("a.ts", 'import fs from "fs"\nfs.promises.writeFile("x", "y")\n')
    expect(fallback.mutations.map((c) => c.api)).toEqual(["writeFile"])
  })

  it("flags fs/promises calls", () => {
    const scan = scanSource("a.ts", 'import { rename } from "node:fs/promises"\nrename("a", "b")\n')
    expect(scan.mutations.map((c) => c.api)).toEqual(["rename"])
  })

  it.each([
    ['import * as fs from "node:fs"', 'fs["writeFileSync"]("x", "y")', "writeFileSync"],
    ['import fs from "fs"', 'fs[`writeFileSync`]("x", "y")', "writeFileSync"],
    ['import fs from "node:fs"', 'fs["promises"]["writeFile"]("x", "y")', "writeFile"],
    ['import * as fs from "fs"', 'fs.promises["writeFile"]("x", "y")', "writeFile"],
    ['import fs from "node:fs"', 'fs["promises"].writeFile("x", "y")', "writeFile"],
    ['import * as fs from "node:fs/promises"', 'await fs["writeFile"]("x", "y")', "writeFile"],
    ['import fs from "fs/promises"', 'await fs["rename"]("x", "y")', "rename"],
  ])("flags static element access: %s; %s", (imports, call, api) => {
    expect(scanSource("a.ts", `${imports}\n${call}`).mutations).toEqual([{ api, line: 2 }])
  })

  it.each([
    ['import fs from "node:fs"', 'const { writeFileSync } = fs; writeFileSync("x", "y")', "writeFileSync"],
    ['import * as fs from "fs"', 'const { writeFileSync: w } = fs; w("x", "y")', "writeFileSync"],
    ['import fs from "node:fs"', 'const f = fs; f.writeFileSync("x", "y")', "writeFileSync"],
    ['import fs from "node:fs"', 'const w = fs.writeFileSync; w("x", "y")', "writeFileSync"],
    ['import fs from "node:fs"', 'const w = fs["writeFileSync"]; const w2 = w; w2("x", "y")', "writeFileSync"],
    ['import fs from "node:fs"', 'const { "writeFileSync": w } = fs; w("x", "y")', "writeFileSync"],
    ['import fs from "node:fs"', 'const { ["writeFileSync"]: w } = fs; w("x", "y")', "writeFileSync"],
    ['import fs from "node:fs"', 'const f = (fs); (f["writeFileSync"])("x", "y")', "writeFileSync"],
    ['import fs from "node:fs"', 'const { promises: p } = fs; await p.writeFile("x", "y")', "writeFile"],
    ['import fs from "fs"', 'const p = fs["promises"]; const w = p.writeFile; await w("x", "y")', "writeFile"],
    ['import fs from "node:fs"', 'const { promises: { writeFile: w } } = fs; await w("x", "y")', "writeFile"],
    ['import { promises as p } from "node:fs"', 'const { writeFile: w } = p; await w("x", "y")', "writeFile"],
    ['import fs from "node:fs/promises"', 'const { writeFile: w } = fs; await w("x", "y")', "writeFile"],
    ['import * as fs from "fs/promises"', 'const f = fs; const w = f["writeFile"]; await w("x", "y")', "writeFile"],
    ['import { writeFile as write } from "node:fs/promises"', 'const w = write; await w("x", "y")', "writeFile"],
  ])("tracks local const bindings: %s; %s", (imports, body, api) => {
    const scan = scanSource("a.ts", `${imports}\nasync function run() {\n${body}\n}`)
    expect(scan).toEqual({ mutations: [{ api, line: 3 }], unknown: [] })
  })

  it.each([
    'fs["someFutureApi"]("x")',
    'const f = fs; f["someFutureApi"]("x")',
    'const { someFutureApi: w } = fs; w("x")',
    'fs[key]("x")',
    'fs.promises[key]("x")',
    'fs["promises"][key]("x")',
    'const w = fs[key]; w("x")',
    'const { [key]: w } = fs; w("x")',
    'fs[key].writeFileSync("x", "y")',
  ])("fails closed on an unknown static or dynamic fs API: %s", (body) => {
    const scan = scanSource("a.ts", `import fs from "node:fs"\n${body}`)
    expect(scan.mutations).toEqual([])
    expect(scan.unknown).toHaveLength(1)
    expect(scan.unknown[0].line).toBe(2)
  })

  it.each([
    'function run(fs: any) { fs.writeFileSync("x", "y") }',
    'const run = (fs: any) => fs["writeFileSync"]("x", "y")',
    '{ const fs = local; fs.writeFileSync("x", "y") }',
    '{ fs.writeFileSync("x", "y"); const fs = local }',
    'function run() { fs.writeFileSync("x", "y"); var fs = local }',
    'function run({ fs }: any) { const w = fs.writeFileSync; w("x", "y") }',
    'try {} catch (fs) { fs["writeFileSync"]("x", "y") }',
    'for (const fs of objects) { fs.writeFileSync("x", "y") }',
    'const run = function fs() { fs.writeFileSync("x", "y") }',
  ])("respects lexical shadowing: %s", (body) => {
    const scan = scanSource("a.ts", `import fs from "node:fs"\n${body}\nfs.writeFileSync("x", "y")`)
    expect(scan).toEqual({ mutations: [{ api: "writeFileSync", line: 3 }], unknown: [] })
  })

  it("respects shadowed named imports and aliases while retaining outer bindings", () => {
    const scan = scanSource(
      "a.ts",
      `
import fs, { writeFileSync as write } from "node:fs"
const f = fs
const w = f.writeFileSync
function run(write: any, f: any, w: any) { write(); f.writeFileSync(); w() }
{ const w = () => {}; w() }
function useOuter() { const alias = w; alias("x", "y") }
write("x", "y")
`,
    )
    expect(scan).toEqual({
      mutations: [
        { api: "writeFileSync", line: 7 },
        { api: "writeFileSync", line: 8 },
      ],
      unknown: [],
    })
  })

  it.each([
    ['let w = fs.writeFileSync; w("x", "y")', "writeFileSync"],
    ['let { writeFileSync: w } = fs; w("x", "y")', "writeFileSync"],
    ['var f = fs; f["writeFileSync"]("x", "y")', "writeFileSync"],
    ['let w = fs.writeFileSync; w("x", "y")', "writeFileSync"],
  ])("tracks mutable aliases conservatively: %s", (body, api) => {
    const scan = scanSource(
      "a.ts",
      `import fs from "node:fs"
${body}`,
    )
    expect(scan.mutations).toEqual([{ api, line: 2 }])
    expect(scan.unknown).toEqual([])
  })

  it("keeps the read-only whitelist through element access and local bindings", () => {
    const scan = scanSource(
      "a.ts",
      `
import fs from "node:fs"
const f = fs
f["readFileSync"]("x")
const { promises: { readFile: read } } = fs
read("x")
const stat = fs["statSync"]
stat("x")
`,
    )
    expect(scan).toEqual({ mutations: [], unknown: [] })
  })

  it("chooses an unknown-guarded mutable alias instead of silently accepting reassignment", () => {
    const scan = scanSource("a.ts", 'import fs from "node:fs"\nlet w = fs.writeFileSync; w = local; w("x", "y")')
    expect(scan.mutations).toEqual([])
    expect(scan.unknown).toEqual([{ api: "writeFileSync", line: 2 }])
  })

  it("does not infer fs bindings from unrelated imports or local objects", () => {
    const scan = scanSource(
      "a.ts",
      `
import fs from "some-other-module"
const f = fs
const { writeFileSync: w } = f
w("x", "y")
const local = { writeFileSync() {} }
local["writeFileSync"]("x", "y")
`,
    )
    expect(scan).toEqual({ mutations: [], unknown: [] })
  })

  it("reports an unknown fs API instead of guessing", () => {
    const scan = scanSource("a.ts", 'import * as fs from "node:fs"\nfs.someFutureApi("x")\n')
    expect(scan.unknown.map((c) => c.api)).toEqual(["someFutureApi"])
    expect(scan.mutations).toEqual([])
  })

  it("does not count fs names that appear only inside strings", () => {
    const scan = scanSource("a.ts", "const s = 'import { writeFileSync } from \"node:fs\"'\n")
    expect(scan.mutations).toEqual([])
  })

  it("requires every production fs mutation to be a generation input or a reasoned exemption", () => {
    const violations: string[] = []
    const unknown: string[] = []
    for (const file of productionSources(join(packageRoot, "src"))) {
      const path = relative(repositoryRoot, file)
      const scan = scanSource(path, readFileSync(file, "utf8"))
      for (const call of scan.unknown) unknown.push(`${path}:${call.line} unknown fs API ${call.api}`)
      if (scan.mutations.length === 0) continue
      if (DSH_HOME_GENERATION_INPUTS.includes(path)) continue
      if (path in DSH_FS_MUTATION_EXEMPTIONS) continue
      violations.push(`${path} calls ${scan.mutations.map((c) => c.api).join(", ")}`)
    }

    expect(unknown).toEqual([])
    expect(violations).toEqual([])
    for (const [path, reason] of Object.entries(DSH_FS_MUTATION_EXEMPTIONS)) {
      expect(reason.trim().length, `exemption for ${path} needs a reason`).toBeGreaterThan(10)
    }
  })

  it("keeps the known Home writers and indirect payload sources registered", () => {
    for (const path of [
      "packages/ellamaka-cordis/src/dsh-web.ts",
      "packages/ellamaka-cordis/src/diagnostics/dump-config.ts",
      "packages/ellamaka-cordis/src/runtime/tools-profile.ts",
    ]) {
      expect(DSH_HOME_GENERATION_INPUTS).toContain(path)
    }
  })

  it("ignores test files that write temporary files", () => {
    const sources = productionSources(join(packageRoot, "src"))
    expect(sources.some((file) => file.endsWith(".test.ts"))).toBe(false)
  })
})
