#!/usr/bin/env bun
import path from "node:path"
import * as ts from "typescript"

export type BoundaryRule =
  | "shared-workbench-import"
  | "shared-workbench-parameter"
  | "store-side-effect-import"
  | "panel-global-command-registration"
  | "component-directory-sdk-construction"
  | "workbench-sdk-provider-owner"
  | "component-pty-runtime-import"
  | "persisted-session-projection"
  | "session-projection-writer-owner"

export type BoundaryViolation = {
  rule: BoundaryRule
  file: string
  detail: string
}

export type BoundaryDebt = BoundaryViolation & {
  owner: string
  removeBy: string
}

export type SourceEntry = {
  file: string
  source: string
}

const SHARED_ROOTS = ["src/components/", "src/pages/session/"]
const WORKBENCH_ROOT = "src/pages/workbench/"
const LEGACY_SESSION_MIGRATION = `${WORKBENCH_ROOT}services/session-store-legacy.ts`
const LEGACY_SESSION_STORAGE_KEY = ["workbench", "sessions"].join(".")
const COMMAND_OWNER = `${WORKBENCH_ROOT}use-workbench-commands.tsx`
const SDK_PROVIDER_OWNERS = new Set([
  `${WORKBENCH_ROOT}parts/workspace.tsx`,
  `${WORKBENCH_ROOT}workbench-directory-provider.tsx`,
])
const PTY_RUNTIME_OWNERS = new Set([`${WORKBENCH_ROOT}pty-manager.tsx`, `${WORKBENCH_ROOT}workbench-actions-ports.ts`])
const SESSION_PROJECTION_WRITERS = new Set([
  `${WORKBENCH_ROOT}index.tsx`,
  `${WORKBENCH_ROOT}workbench-actions.ts`,
  `${WORKBENCH_ROOT}parts/session-tree.tsx`,
])
const STORE_FILES = new Set([`${WORKBENCH_ROOT}view-store.tsx`, `${WORKBENCH_ROOT}workbench-store.ts`])
const WORKBENCH_PARAMETERS = new Set(["panelID", "panelId", "spacePath", "spaceName"])
const BOUNDARY_RULES: ReadonlySet<string> = new Set<BoundaryRule>([
  "shared-workbench-import",
  "shared-workbench-parameter",
  "store-side-effect-import",
  "panel-global-command-registration",
  "component-directory-sdk-construction",
  "workbench-sdk-provider-owner",
  "component-pty-runtime-import",
  "persisted-session-projection",
  "session-projection-writer-owner",
])

function normalize(file: string) {
  return file.replaceAll("\\", "/").replace(/^\.\//, "")
}

function isShared(file: string) {
  return SHARED_ROOTS.some((root) => file.startsWith(root))
}

function resolvesToWorkbench(file: string, specifier: string) {
  if (specifier.startsWith("@/")) return specifier.startsWith("@/pages/workbench/")
  if (!specifier.startsWith(".")) return false
  return normalize(path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier))).startsWith(
    WORKBENCH_ROOT,
  )
}

function isStoreSideEffectImport(specifier: string) {
  return (
    specifier === "@/context/sdk" ||
    specifier === "@/context/server-sdk" ||
    specifier === "@solidjs/router" ||
    specifier.includes("pty-manager") ||
    specifier.includes("session-store") ||
    specifier.includes("/dialog") ||
    specifier.includes("/toast")
  )
}

function sourceImports(sourceFile: ts.SourceFile) {
  const imports: string[] = []

  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      imports.push(node.moduleSpecifier.text)
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      imports.push(node.moduleSpecifier.text)
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const specifier = node.arguments[0]
      if (specifier && ts.isStringLiteral(specifier)) imports.push(specifier.text)
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return imports
}

function propertyName(node: ts.PropertySignature | ts.PropertyDeclaration): string | undefined {
  if (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) return node.name.text
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isBoundaryRule(value: unknown): value is BoundaryRule {
  return typeof value === "string" && BOUNDARY_RULES.has(value)
}

function parseBoundaryDebt(value: unknown): BoundaryDebt[] {
  if (!Array.isArray(value)) throw new Error("Workbench boundary debt must be an array")
  return value.map((item, index) => {
    if (
      !isRecord(item) ||
      !isBoundaryRule(item.rule) ||
      typeof item.file !== "string" ||
      typeof item.detail !== "string" ||
      typeof item.owner !== "string" ||
      typeof item.removeBy !== "string"
    ) {
      throw new Error(`Invalid Workbench boundary debt at index ${index}`)
    }
    return {
      rule: item.rule,
      file: item.file,
      detail: item.detail,
      owner: item.owner,
      removeBy: item.removeBy,
    }
  })
}

export function inspectWorkbenchSources(entries: SourceEntry[]) {
  const violations: BoundaryViolation[] = []

  for (const entry of entries) {
    const file = normalize(entry.file)
    const sourceFile = ts.createSourceFile(file, entry.source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)

    for (const specifier of sourceImports(sourceFile)) {
      if (isShared(file) && resolvesToWorkbench(file, specifier)) {
        violations.push({ rule: "shared-workbench-import", file, detail: specifier })
      }
      if (STORE_FILES.has(file) && isStoreSideEffectImport(specifier)) {
        violations.push({ rule: "store-side-effect-import", file, detail: specifier })
      }
      if (
        file.startsWith(WORKBENCH_ROOT) &&
        !file.endsWith(".test.ts") &&
        !file.endsWith(".test.tsx") &&
        !STORE_FILES.has(file) &&
        !PTY_RUNTIME_OWNERS.has(file) &&
        (specifier === "./pty-manager" || specifier.endsWith("/pty-manager"))
      ) {
        violations.push({ rule: "component-pty-runtime-import", file, detail: specifier })
      }
    }

    const visit = (node: ts.Node) => {
      if (
        isShared(file) &&
        (ts.isPropertySignature(node) || ts.isPropertyDeclaration(node)) &&
        WORKBENCH_PARAMETERS.has(propertyName(node) ?? "")
      ) {
        violations.push({ rule: "shared-workbench-parameter", file, detail: propertyName(node)! })
      }

      if (file.startsWith(WORKBENCH_ROOT) && file !== COMMAND_OWNER && ts.isCallExpression(node)) {
        const expression = node.expression
        const command =
          ts.isPropertyAccessExpression(expression) && expression.name.text === "register"
            ? node.arguments[0]
            : undefined
        if (command && ts.isStringLiteral(command)) {
          violations.push({ rule: "panel-global-command-registration", file, detail: command.text })
        }
      }

      if (file.startsWith(`${WORKBENCH_ROOT}parts/`) && ts.isCallExpression(node)) {
        const expression = node.expression
        const name = ts.isPropertyAccessExpression(expression)
          ? expression.name.text
          : ts.isIdentifier(expression)
            ? expression.text
            : undefined
        if (name === "createDirSdkContext") {
          violations.push({ rule: "component-directory-sdk-construction", file, detail: name })
        }
      }

      if (
        file.startsWith(WORKBENCH_ROOT) &&
        !SDK_PROVIDER_OWNERS.has(file) &&
        (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
        ts.isIdentifier(node.tagName) &&
        node.tagName.text === "SDKProvider"
      ) {
        violations.push({ rule: "workbench-sdk-provider-owner", file, detail: "SDKProvider" })
      }

      if (
        file.startsWith(WORKBENCH_ROOT) &&
        !SESSION_PROJECTION_WRITERS.has(file) &&
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "useSessionProjectionWriter"
      ) {
        violations.push({ rule: "session-projection-writer-owner", file, detail: node.expression.text })
      }

      if (
        file.startsWith(WORKBENCH_ROOT) &&
        file !== LEGACY_SESSION_MIGRATION &&
        ts.isStringLiteral(node) &&
        node.text === LEGACY_SESSION_STORAGE_KEY
      ) {
        violations.push({ rule: "persisted-session-projection", file, detail: node.text })
      }

      ts.forEachChild(node, visit)
    }

    visit(sourceFile)
  }

  return violations.sort((a, b) =>
    `${a.rule}\n${a.file}\n${a.detail}`.localeCompare(`${b.rule}\n${b.file}\n${b.detail}`),
  )
}

function boundaryKey(item: BoundaryViolation) {
  return `${item.rule}\n${item.file}\n${item.detail}`
}

export function reconcileBoundaryDebt(violations: BoundaryViolation[], debt: BoundaryDebt[]) {
  const current = new Set(violations.map(boundaryKey))
  const allowed = new Set(debt.map(boundaryKey))
  return {
    unexpected: violations.filter((item) => !allowed.has(boundaryKey(item))),
    stale: debt.filter((item) => !current.has(boundaryKey(item))),
  }
}

async function readSources(root: string) {
  const sourceRoot = path.join(root, "src")
  const roots = ["components", "pages/session", "pages/workbench"]
  const files = (
    await Promise.all(
      roots.flatMap((directory) =>
        ["**/*.ts", "**/*.tsx"].map(async (pattern) =>
          Array.fromAsync(
            new Bun.Glob(pattern).scan({
              cwd: path.join(sourceRoot, directory),
              onlyFiles: true,
            }),
          ).then((items) => items.map((file) => path.posix.join(directory, file))),
        ),
      ),
    )
  ).flat()
  return Promise.all(
    files.map(async (file) => ({
      file: normalize(path.posix.join("src", file)),
      source: await Bun.file(path.join(sourceRoot, file)).text(),
    })),
  )
}

function formatViolation(item: BoundaryViolation) {
  return `${item.rule}: ${item.file} -> ${item.detail}`
}

async function main() {
  const root = path.resolve(import.meta.dir, "..")
  const entries = await readSources(root)
  const debt = parseBoundaryDebt(await Bun.file(path.join(import.meta.dir, "workbench-boundary-debt.json")).json())
  const violations = inspectWorkbenchSources(entries)
  const result = reconcileBoundaryDebt(violations, debt)

  if (result.unexpected.length === 0 && result.stale.length === 0) {
    console.log(`Workbench boundaries OK (${violations.length} tracked debt items)`)
    return
  }

  for (const item of result.unexpected) console.error(`Unexpected boundary violation: ${formatViolation(item)}`)
  for (const item of result.stale) console.error(`Stale boundary debt: ${formatViolation(item)}`)
  process.exitCode = 1
}

if (import.meta.main) await main()
