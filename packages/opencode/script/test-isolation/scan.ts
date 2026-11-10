/**
 * Static scanner behind the test isolation gate.
 *
 * The scanner reads TypeScript sources with the compiler API and reports every
 * pattern the isolation rules forbid. It deliberately reports facts about the
 * source, not judgements about intent: the baseline holds the known debt, and
 * anything the scanner finds outside the baseline is a new violation.
 */

import path from "node:path"
import ts from "typescript"
import { ALLOWED_MODULE_REPLACERS, INTEGRATION_FILES, INTEGRATION_ROOTS, type RuleId } from "./rules"

export type Violation = {
  rule: RuleId
  file: string
  line: number
  detail: string
}

export type ScannerOptions = {
  /** The repository root, for checks that need to resolve paths. */
  root: string
}

const TEST_FILE = /\.(?:test|spec)\.(?:[cm]?[jt]s|[jt]sx)$/

export function isTestFile(relative: string) {
  return TEST_FILE.test(relative)
}

export function isIntegrationLayer(relative: string) {
  if (/-integration\.test\.(?:ts|tsx)$/.test(relative)) return true
  if (/-e2e\.test\.(?:ts|tsx)$/.test(relative)) return true
  if (INTEGRATION_FILES.includes(relative)) return true
  return INTEGRATION_ROOTS.some((root) => relative.startsWith(root + "/"))
}

/**
 * Exceptions are exact paths. A fixture directory may also contain executable
 * tests; exempting the entire directory would hide new module pollution.
 */
function mayReplaceModules(relative: string) {
  if (ALLOWED_MODULE_REPLACERS.includes(relative)) return true
  return relative === "packages/ellamaka-app/script/fixtures/src/leaky.test.ts"
}

function textOf(source: ts.SourceFile, node: ts.Node) {
  return node.getText(source)
}

/** The literal module id passed to mock.module, when it is statically known. */
function moduleTarget(source: ts.SourceFile, call: ts.CallExpression) {
  const first = call.arguments[0]
  if (!first) return undefined
  if (ts.isStringLiteralLike(first)) return first.text
  return undefined
}

function isProcessEnvObject(node: ts.Node) {
  if (!ts.isPropertyAccessExpression(node)) return false
  if (!ts.isIdentifier(node.expression)) return false
  if (node.expression.text !== "process" && node.expression.text !== "Bun") return false
  return node.name.text === "env"
}

function isEnvMember(node: ts.Node) {
  // process.env.KEY
  if (ts.isPropertyAccessExpression(node) && isProcessEnvObject(node.expression)) return true
  // process.env["KEY"]
  if (ts.isElementAccessExpression(node) && isProcessEnvObject(node.expression)) return true
  return false
}

/**
 * A delete expression, recognised without depending on the node kind name.
 *
 * The repository resolves "typescript" to the native preview build, which
 * names unary operator nodes differently from the classic compiler. Matching on
 * the text keeps the scanner working on either implementation.
 */
function isDeleteLike(node: ts.Node) {
  // The repository resolves "typescript" to the native preview build, which
  // names the delete node DeleteExpression; the classic compiler uses
  // PrefixUnaryExpression. Both are accepted so the scanner works either way.
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- The native preview build has a node kind the classic compiler does not.
  const checker = ts as unknown as { isDeleteExpression?: (node: ts.Node) => boolean }
  if (typeof checker.isDeleteExpression === "function" && checker.isDeleteExpression(node)) return true
  if (ts.isPrefixUnaryExpression(node)) return node.getText().startsWith("delete")
  return false
}

/** The expression a delete applies to, whichever node kind carries it. */
function deletedExpression(node: ts.Node): ts.Node | undefined {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- The delete node carries its expression on different properties per implementation.
  const candidate = node as unknown as { expression?: ts.Node; operand?: ts.Node }
  return candidate.expression ?? candidate.operand
}

function envKeyOf(source: ts.SourceFile, node: ts.Node): string | undefined {
  if (ts.isPropertyAccessExpression(node) && isProcessEnvObject(node.expression)) {
    return node.name.text
  }
  if (ts.isElementAccessExpression(node) && isProcessEnvObject(node.expression)) {
    const arg = node.argumentExpression
    if (arg && ts.isStringLiteralLike(arg)) return arg.text
  }
  return undefined
}

/** Call names that wait for a fixed amount of time. */
const FIXED_WAIT_CALLS = new Set(["sleep", "delay", "setTimeout", "waitFor"])

function isFixedWaitCall(node: ts.CallExpression) {
  const callee = node.expression
  if (!ts.isIdentifier(callee)) return false
  if (!FIXED_WAIT_CALLS.has(callee.text)) return false
  // A zero-argument wait is not a delay. A single numeric or string argument is.
  if (node.arguments.length === 0) return false
  const arg = node.arguments[0]
  // The native preview build does not name numeric literals NumericLiteral, so
  // the shape of the literal is read from its text.
  const literal = arg.getText()
  if (/^[0-9]+$/.test(literal)) return literal !== "0"
  if (/^0[xob]/i.test(literal)) return true
  if (ts.isStringLiteralLike(arg)) return true
  if (ts.isIdentifier(arg) && arg.text === "millis") return true
  if (ts.isIdentifier(arg) && arg.text === "seconds") return true
  if (ts.isIdentifier(arg) && arg.text === "milliseconds") return true
  if (ts.isIdentifier(arg) && arg.text === "seconds") return true
  return false
}

/** Effect's sleep is namespaced, so it needs its own check. */
/**
 * Whether a wait call actually waits.
 *
 * A zero-length wait is a yield rather than a delay, so it is not the
 * fixed-delay synchronization the rule forbids.
 */
function waitsForTime(node: ts.CallExpression) {
  if (node.arguments.length === 0) return false
  const arg = node.arguments[0]
  const literal = arg.getText()
  if (/^[0-9]+$/.test(literal)) return literal !== "0"
  return true
}

function isEffectSleep(node: ts.CallExpression) {
  const callee = node.expression
  if (!ts.isPropertyAccessExpression(callee)) return false
  if (callee.name.text !== "sleep") return false
  const owner = callee.expression
  return ts.isIdentifier(owner) && owner.text === "Effect"
}

/** Bun.sleep and node:timers sleep. */
function isBuiltinSleep(node: ts.CallExpression) {
  const callee = node.expression
  if (ts.isPropertyAccessExpression(callee)) {
    if (callee.name.text !== "sleep") return false
    const owner = callee.expression
    return ts.isIdentifier(owner) && owner.text === "Bun"
  }
  return false
}

const LIVE_IO_CALLS = new Set(["spawn", "spawnSync", "execSync", "exec", "watch", "createServer", "listen"])

/** The node:child_process entry points that start a real OS process. */
const CHILD_PROCESS_CALLS = new Set(["exec", "execSync", "execFile", "execFileSync", "spawn", "spawnSync", "fork"])

/** How this file names the child_process API and the network entry points. */
type LiveIoBindings = {
  /** Local identifiers imported from node:child_process. */
  childProcessFunctions: Set<string>
  /** Local aliases for a namespace import of node:child_process. */
  childProcessNamespaces: Set<string>
}

/**
 * Read the import bindings once per file.
 *
 * A call is live I/O because of what the identifier was imported from, not
 * because of its spelling: a locally defined spawn() is not a subprocess.
 */
function collectLiveIoBindings(source: ts.SourceFile): LiveIoBindings {
  const childProcessFunctions = new Set<string>()
  const childProcessNamespaces = new Set<string>()
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue
    const specifier = statement.moduleSpecifier
    if (!ts.isStringLiteralLike(specifier)) continue
    if (specifier.text !== "node:child_process" && specifier.text !== "child_process") continue
    const bindings = statement.importClause?.namedBindings
    if (!bindings) continue
    if (ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        const imported = element.propertyName ? element.propertyName.text : element.name.text
        if (CHILD_PROCESS_CALLS.has(imported)) childProcessFunctions.add(element.name.text)
      }
      continue
    }
    if (ts.isNamespaceImport(bindings)) childProcessNamespaces.add(bindings.name.text)
  }
  return { childProcessFunctions, childProcessNamespaces }
}

function isLiveIoCall(node: ts.CallExpression, bindings: LiveIoBindings) {
  const callee = node.expression
  // A bare call: fetch(), or a child_process function imported by name.
  if (ts.isIdentifier(callee)) {
    if (callee.text === "fetch") return true
    return bindings.childProcessFunctions.has(callee.text)
  }
  if (!ts.isPropertyAccessExpression(callee)) return false
  const owner = callee.expression
  const ownerName = ts.isIdentifier(owner) ? owner.text : undefined
  if (ownerName && bindings.childProcessNamespaces.has(ownerName)) {
    return CHILD_PROCESS_CALLS.has(callee.name.text)
  }
  if (ownerName === "Bun") {
    if (LIVE_IO_CALLS.has(callee.name.text)) return true
    // Bun.$ runs a shell command.
    if (callee.name.text === "$") return true
    return false
  }
  if (ownerName === "fs" && (callee.name.text === "watch" || callee.name.text === "watchFile")) return true
  return false
}

/**
 * The Global.Path member a write targets, if any.
 *
 * The path may be written directly (Global.Path.config) or concatenated
 * (Global.Path.config + "/settings.jsonc").
 */
function globalPathMember(node: ts.Node | undefined): string | undefined {
  if (!node) return undefined
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return globalPathMember(node.left)
  }
  if (!ts.isPropertyAccessExpression(node)) return undefined
  const owner = node.expression
  if (!ts.isPropertyAccessExpression(owner)) return undefined
  if (!ts.isIdentifier(owner.expression)) return undefined
  if (owner.expression.text !== "Global") return undefined
  if (owner.name.text !== "Path") return undefined
  if (!ts.isIdentifier(node.name)) return undefined
  return "Global.Path." + node.name.text
}

/**
 * A bun:test control call.
 *
 * The owner has to be the test API itself (test, it, describe, or the runner
 * wrappers the packages use). A product method that shares the name is not a
 * test control.
 */
function isTestControlCall(node: ts.CallExpression) {
  const callee = node.expression
  if (!ts.isPropertyAccessExpression(callee)) return false
  const member = callee.name.text
  if (member !== "only" && member !== "skip" && member !== "todo") return false
  const owner = callee.expression
  if (!ts.isIdentifier(owner)) return false
  return TEST_CONTROL_OWNERS.has(owner.text)
}

/** The identifiers that introduce a bun:test control. */
const TEST_CONTROL_OWNERS = new Set(["test", "it", "describe", "bench", "suite", "testIf", "itIf", "describeIf"])

type TestControlBindings = {
  identifiers: Set<string>
  namespaces: Set<string>
}

function bindingNames(name: ts.BindingName, names: Set<string>) {
  if (ts.isIdentifier(name)) {
    names.add(name.text)
    return
  }
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue
    bindingNames(element.name, names)
  }
}

function bindingHasName(name: ts.BindingName, target: string) {
  const names = new Set<string>()
  bindingNames(name, names)
  return names.has(target)
}

function statementDeclaresName(statement: ts.Statement, target: string) {
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.some((declaration) => bindingHasName(declaration.name, target))
  }
  if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
    return statement.name?.text === target
  }
  return false
}

/**
 * Resolve the local names that refer to Bun's test controls.
 *
 * Canonical names are globals in Bun's test runner, but a test file can shadow
 * one of those names with a local binding. Named and namespace imports from
 * bun:test may also rename the controls, and those aliases still need the same
 * isolation rule.
 */
function collectTestControlBindings(source: ts.SourceFile): TestControlBindings {
  const identifiers = new Set(TEST_CONTROL_OWNERS)
  const namespaces = new Set<string>()
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      const specifier = statement.moduleSpecifier
      const clause = statement.importClause
      if (!ts.isStringLiteralLike(specifier) || !clause) continue

      if (specifier.text === "bun:test") {
        const bindings = clause.namedBindings
        if (bindings && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            const imported = element.propertyName ? element.propertyName.text : element.name.text
            if (TEST_CONTROL_OWNERS.has(imported)) identifiers.add(element.name.text)
          }
        } else if (bindings && ts.isNamespaceImport(bindings)) {
          namespaces.add(bindings.name.text)
        }
        continue
      }

      if (clause.name) identifiers.delete(clause.name.text)
      const bindings = clause.namedBindings
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) identifiers.delete(element.name.text)
      } else if (bindings && ts.isNamespaceImport(bindings)) {
        identifiers.delete(bindings.name.text)
      }
      continue
    }

    for (const name of TEST_CONTROL_OWNERS) {
      if (statementDeclaresName(statement, name)) identifiers.delete(name)
    }
  }
  return { identifiers, namespaces }
}

function isShadowedInLexicalScope(identifier: ts.Identifier) {
  const name = identifier.text
  let node: ts.Node | undefined = identifier.parent
  while (node && !ts.isSourceFile(node)) {
    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node)) &&
      (node.parameters.some((parameter) => bindingHasName(parameter.name, name)) ||
        ("name" in node && node.name && ts.isIdentifier(node.name) && node.name.text === name))
    ) {
      return true
    }
    if (ts.isBlock(node) && node.statements.some((statement) => statementDeclaresName(statement, name))) return true
    if (ts.isCatchClause(node) && node.variableDeclaration && bindingHasName(node.variableDeclaration.name, name)) {
      return true
    }
    node = node.parent
  }
  return false
}

function isTestControlOwner(node: ts.Node, bindings: TestControlBindings) {
  if (ts.isIdentifier(node)) return bindings.identifiers.has(node.text) && !isShadowedInLexicalScope(node)
  if (!ts.isPropertyAccessExpression(node)) return false
  const namespace = node.expression
  return (
    ts.isIdentifier(namespace) &&
    bindings.namespaces.has(namespace.text) &&
    !isShadowedInLexicalScope(namespace) &&
    TEST_CONTROL_OWNERS.has(node.name.text)
  )
}

function isConcurrentTestControlAccess(node: ts.PropertyAccessExpression, bindings: TestControlBindings) {
  return node.name.text === "concurrent" && isTestControlOwner(node.expression, bindings)
}

/** setTimeout(callback, ms) and setInterval(callback, ms). */
function isTimerCall(node: ts.CallExpression) {
  const callee = node.expression
  if (!ts.isIdentifier(callee)) return false
  return callee.text === "setTimeout" || callee.text === "setInterval"
}

/** True when the owner of a member expression is the Bun global. */
function isBunOwner(callee: ts.PropertyAccessExpression) {
  return ts.isIdentifier(callee.expression) && callee.expression.text === "Bun"
}

/**
 * The shared path a write targets, if any.
 *
 * Global.Path.config, Global.Path.config + "/x", and
 * path.join(Global.Path.config, "x") all name the same kind of shared state.
 */
function sharedPathTarget(node: ts.Node | undefined): string | undefined {
  if (!node) return undefined
  const direct = globalPathMember(node)
  if (direct) return direct
  if (!ts.isCallExpression(node)) return undefined
  const callee = node.expression
  if (!ts.isPropertyAccessExpression(callee)) return undefined
  if (callee.name.text !== "join") return undefined
  const owner = callee.expression
  if (!ts.isIdentifier(owner)) return undefined
  if (owner.text !== "path" && owner.text !== "Path") return undefined
  for (const argument of node.arguments) {
    const found = globalPathMember(argument)
    if (found) return found
  }
  return undefined
}

export function scanSource(relative: string, sourceText: string, _options: ScannerOptions): Violation[] {
  const violations: Violation[] = []
  if (!isTestFile(relative)) return violations
  const isIntegration = isIntegrationLayer(relative)
  const canReplaceModules = mayReplaceModules(relative)

  const source = ts.createSourceFile(relative, sourceText, ts.ScriptTarget.Latest, true)
  const liveIoBindings = collectLiveIoBindings(source)
  const testControlBindings = collectTestControlBindings(source)
  const lineOf = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1

  const report = (rule: RuleId, node: ts.Node, detail: string) => {
    violations.push({ rule, file: relative, line: lineOf(node), detail })
  }

  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression

      // TISO001 - mock.module
      // The callee is either the bare identifier "mock" (bun:test mock.module is
      // always called as a member) or a member expression whose object is
      // "mock". Both shapes have to be recognized.
      const isMockModule =
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === "module" &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === "mock"
      if (isMockModule) {
        if (!canReplaceModules) {
          const target = moduleTarget(source, node)
          report("TISO001", node, target ? "mock.module(" + target + ")" : "mock.module(<dynamic>)")
        }
      }

      // TISO003 - fixed delay
      if (isFixedWaitCall(node) || isEffectSleep(node) || isBuiltinSleep(node) || isTimerCall(node)) {
        if (waitsForTime(node)) report("TISO003", node, textOf(source, node).slice(0, 80))
      }

      // TISO004 - live I/O in the unit layer
      if (!isIntegration && isLiveIoCall(node, liveIoBindings)) {
        report("TISO004", node, textOf(source, node).slice(0, 80))
      }

      // TISO005 - .only / .skip / .todo
      // Only the bun:test API counts. A product method that happens to be named
      // skip or todo (controller.skip(), sdk.session.todo()) is not a test
      // control and must not be reported.
      if (isTestControlCall(node)) {
        report("TISO005", node, textOf(source, node).slice(0, 60))
      }
    }

    // TISO008 - direct Bun in-process concurrent controls. Match the member
    // access rather than only a direct call so chained forms such as
    // test.concurrent.each() cannot bypass the rule. Owner-aware package
    // helpers (for example cliIt.concurrent) are deliberately outside this
    // direct-control gate and must own/document their isolation separately.
    if (ts.isPropertyAccessExpression(node) && isConcurrentTestControlAccess(node, testControlBindings)) {
      report("TISO008", node, textOf(source, node).slice(0, 80))
    }

    // TISO002 - direct environment mutation
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      if (isEnvMember(node.left)) {
        const key = envKeyOf(source, node.left)
        report("TISO002", node, key ? "process.env." + key : "process.env[...]")
      }
    }
    // The delete form is matched on text rather than on a node kind: the
    // repository's typescript package is the native preview build, whose AST
    // uses its own node names for unary operators.
    const deleted = isDeleteLike(node) ? deletedExpression(node) : undefined
    if (deleted && isEnvMember(deleted)) {
      const key = envKeyOf(source, deleted)
      report("TISO002", node, key ? "process.env." + key : "process.env[...]")
    }

    // TISO006 - writing a shared path
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      const calleeMember = ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined
      const isBunWrite = ts.isPropertyAccessExpression(callee) && calleeMember === "write" && isBunOwner(callee)
      const isWrite =
        calleeMember === "writeFile" ||
        calleeMember === "writeFileSync" ||
        calleeMember === "mkdir" ||
        calleeMember === "mkdirSync" ||
        isBunWrite
      if (isWrite) {
        const first = node.arguments[0]
        const shared = sharedPathTarget(first)
        if (shared) report("TISO006", node, shared)
        if (first && ts.isStringLiteralLike(first) && first.text.startsWith("/tmp/")) {
          report("TISO006", node, first.text)
        }
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(source)
  return violations
}

/** A stable key that identifies one violation precisely enough for a baseline. */
export function violationKey(violation: Violation) {
  return violation.rule + "|" + violation.file + "|" + violation.detail
}

export type HomeBindingRef = {
  file: string
  line: number
  target: string
}

export type PackageDiscovery = {
  packageDir: string
  packageName: string
  testFiles: string[]
  reachableHelpers: string[]
  homeBindings: HomeBindingRef[]
  preloadValid: boolean
  preloadIssues: string[]
}

export type GateFileSystem = {
  files: Map<string, string>
}

const HOME_BOUND_CORE_MODULES = new Set([
  "@wopal/ellamaka-core/global",
  "@wopal/ellamaka-core/account",
  "@wopal/ellamaka-core/config",
  "@wopal/ellamaka-core/npm",
  "@wopal/ellamaka-core/models-dev",
  "@wopal/ellamaka-core/location-layer",
  "@wopal/ellamaka-core/plugin/boot",
  "@wopal/ellamaka-core/util/effect-flock",
  "@wopal/ellamaka-core/util/log",
])

/**
 * Layer owners whose `.defaultLayer` is independent of Global.defaultLayer /
 * Global.Path and therefore safe in a `no-global-paths` package.
 */
const SAFE_DEFAULT_LAYER_OWNERS = new Set([
  "AppFileSystem",
  "AppProcess",
  "CrossSpawnSpawner",
  "EventV2",
  "PluginV2",
  "AgentV2",
  "Policy",
  "Catalog",
  "Git",
  "Project",
  "Location",
  "AISDK",
  "RequestExecutor",
  "Todo",
  "SessionStatus",
  "BackgroundJob",
  "InternalHook",
  "Truncate",
  "RepositoryCache",
  "RuntimeFlags",
  "SyncEvent",
  "EventV2Bridge",
  "Vcs",
  "InstanceStore",
  "SessionDirectoryHealth",
  "SessionProjection",
])

const KNOWN_HOME_BOUND_DEFAULT_LAYER_OWNERS = new Set([
  "Global",
  "AccountV2",
  "Account",
  "Config",
  "Npm",
  "ModelsDev",
  "PluginBoot",
  "EffectFlock",
  "Auth",
  "Provider",
  "ProviderAuth",
  "Plugin",
  "Skill",
  "Agent",
  "Session",
  "SessionPrompt",
  "SessionProcessor",
  "SessionCompaction",
  "SessionRevert",
  "SessionSummary",
  "SessionRunState",
  "SystemPrompt",
  "LLM",
  "Command",
  "MCP",
  "McpAuth",
  "LSP",
  "LSPObserver",
  "ToolRegistry",
  "Reference",
  "Instruction",
  "Format",
  "Ripgrep",
  "File",
  "FileWatcher",
  "ShareNext",
  "ShareSession",
  "InstanceBootstrap",
  "Workspace",
  "Rule",
])

function normalizeRel(p: string) {
  return p.split(path.sep).join("/").replace(/^\.\//, "")
}

function isGlobalImportSpecifier(specifier: string) {
  return specifier === "@wopal/ellamaka-core/global" || /(?:^|\/)global(?:\.[mc]?[jt]s)?$/.test(specifier)
}

function isHomeBoundImportSpecifier(specifier: string) {
  if (HOME_BOUND_CORE_MODULES.has(specifier)) return true
  if (isGlobalImportSpecifier(specifier)) return true
  return /(?:^|\/)(?:account|models-dev|location-layer|effect-flock)(?:\.[mc]?[jt]s)?$/.test(specifier)
}

type HomeImportBindings = {
  globalIdentifiers: Set<string>
  globalNamespaces: Set<string>
  homeBoundLayerOwners: Set<string>
  directHomeBoundBindings: Map<string, string>
  safeLayerOwners: Set<string>
}

function collectHomeImportBindings(source: ts.SourceFile): HomeImportBindings {
  const globalIdentifiers = new Set<string>(["Global"])
  const globalNamespaces = new Set<string>()
  const homeBoundLayerOwners = new Set<string>(KNOWN_HOME_BOUND_DEFAULT_LAYER_OWNERS)
  const directHomeBoundBindings = new Map<string, string>()
  const safeLayerOwners = new Set<string>(SAFE_DEFAULT_LAYER_OWNERS)

  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue
    if (statement.importClause?.isTypeOnly) continue
    const specifierNode = statement.moduleSpecifier
    if (!ts.isStringLiteralLike(specifierNode)) continue
    const specifier = specifierNode.text
    const clause = statement.importClause
    if (!clause) continue

    const fromGlobal = isGlobalImportSpecifier(specifier)
    const fromHomeBound = isHomeBoundImportSpecifier(specifier)

    if (clause.name) {
      const local = clause.name.text
      if (!fromGlobal) globalIdentifiers.delete(local)
    }

    const named = clause.namedBindings
    if (named && ts.isNamespaceImport(named)) {
      const local = named.name.text
      if (fromGlobal) {
        globalIdentifiers.add(local)
        globalNamespaces.add(local)
      } else {
        globalIdentifiers.delete(local)
        if (fromHomeBound) homeBoundLayerOwners.add(local)
      }
    } else if (named && ts.isNamedImports(named)) {
      for (const el of named.elements) {
        if (el.isTypeOnly) continue
        const imported = el.propertyName ? el.propertyName.text : el.name.text
        const local = el.name.text
        if (fromGlobal) {
          if (imported === "Global") {
            globalIdentifiers.add(local)
          } else if (
            imported === "Path" ||
            imported === "Service" ||
            imported === "layer" ||
            imported === "defaultLayer" ||
            imported === "layerWith" ||
            imported === "make" ||
            imported === "ensure" ||
            imported === "bindWopalHome"
          ) {
            globalNamespaces.add(local + ":" + imported)
          }
        } else {
          if (local === "Global") globalIdentifiers.delete("Global")
          if (fromHomeBound && imported === "defaultLayer") {
            const modShort =
              specifier
                .split("/")
                .pop()
                ?.replace(/\.[cm]?[jt]s$/, "") ?? specifier
            directHomeBoundBindings.set(local, `${modShort}.defaultLayer`)
          } else if (fromHomeBound || KNOWN_HOME_BOUND_DEFAULT_LAYER_OWNERS.has(imported)) {
            homeBoundLayerOwners.add(local)
            safeLayerOwners.delete(local)
          } else if (SAFE_DEFAULT_LAYER_OWNERS.has(imported)) {
            safeLayerOwners.add(local)
            homeBoundLayerOwners.delete(local)
          }
        }
      }
    }
  }

  for (const statement of source.statements) {
    if (statementDeclaresName(statement, "Global")) {
      globalIdentifiers.delete("Global")
    }
    if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) {
        const init = decl.initializer
        if (!init) continue
        if (ts.isIdentifier(decl.name) && ts.isPropertyAccessExpression(init)) {
          if (
            init.name.text === "defaultLayer" &&
            ts.isIdentifier(init.expression) &&
            homeBoundLayerOwners.has(init.expression.text) &&
            !safeLayerOwners.has(init.expression.text)
          ) {
            directHomeBoundBindings.set(decl.name.text, `${init.expression.text}.defaultLayer`)
          }
        } else if (
          ts.isObjectBindingPattern(decl.name) &&
          ts.isIdentifier(init) &&
          homeBoundLayerOwners.has(init.text) &&
          !safeLayerOwners.has(init.text)
        ) {
          for (const el of decl.name.elements) {
            const prop =
              el.propertyName && ts.isIdentifier(el.propertyName)
                ? el.propertyName.text
                : ts.isIdentifier(el.name)
                  ? el.name.text
                  : undefined
            if (prop === "defaultLayer" && ts.isIdentifier(el.name)) {
              directHomeBoundBindings.set(el.name.text, `${init.text}.defaultLayer`)
            }
          }
        }
      }
    }
  }

  return { globalIdentifiers, globalNamespaces, homeBoundLayerOwners, directHomeBoundBindings, safeLayerOwners }
}

function isInTypePosition(node: ts.Node): boolean {
  let current: ts.Node | undefined = node
  while (current && !ts.isSourceFile(current)) {
    if (
      ts.isTypeNode(current) ||
      ts.isTypeAliasDeclaration(current) ||
      ts.isInterfaceDeclaration(current) ||
      (ts.isImportSpecifier(current) && current.isTypeOnly) ||
      (ts.isImportClause(current) && current.isTypeOnly)
    ) {
      return true
    }
    current = current.parent
  }
  return false
}

export function scanHomeBindingsInSource(relative: string, sourceText: string): HomeBindingRef[] {
  const source = ts.createSourceFile(relative, sourceText, ts.ScriptTarget.Latest, true)
  const bindings = collectHomeImportBindings(source)
  const refs: HomeBindingRef[] = []
  const seen = new Set<string>()
  const lineOf = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1

  const add = (node: ts.Node, target: string) => {
    const line = lineOf(node)
    const key = `${line}:${target}`
    if (seen.has(key)) return
    seen.add(key)
    refs.push({ file: relative, line, target })
  }

  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) return
    if (isInTypePosition(node)) return

    if (ts.isPropertyAccessExpression(node)) {
      const expr = node.expression
      const prop = node.name.text

      // Global.Path.<member> or Global.<member>
      if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression)) {
        const rootId = expr.expression
        if (bindings.globalIdentifiers.has(rootId.text) && !isShadowedInLexicalScope(rootId)) {
          if (expr.name.text === "Path") {
            add(node, `Global.Path.${prop}`)
            return
          }
        }
      }

      if (ts.isIdentifier(expr)) {
        if (bindings.globalIdentifiers.has(expr.text) && !isShadowedInLexicalScope(expr)) {
          add(node, `Global.${prop}`)
          return
        }

        if (prop === "defaultLayer" && !isShadowedInLexicalScope(expr)) {
          const owner = expr.text
          if (bindings.homeBoundLayerOwners.has(owner) && !bindings.safeLayerOwners.has(owner)) {
            add(node, `${owner}.defaultLayer`)
            return
          }
        }
      }
    }

    if (ts.isIdentifier(node)) {
      for (const entry of bindings.globalNamespaces) {
        const [local, imported] = entry.split(":")
        if (imported && node.text === local && !isShadowedInLexicalScope(node)) {
          add(node, `Global.${imported}`)
        }
      }
      const directTarget = bindings.directHomeBoundBindings.get(node.text)
      if (directTarget && !isShadowedInLexicalScope(node)) {
        const isDeclarationSite =
          (ts.isVariableDeclaration(node.parent) && node.parent.name === node) ||
          (ts.isBindingElement(node.parent) && (node.parent.name === node || node.parent.propertyName === node))
        if (!isDeclarationSite) {
          add(node, directTarget)
        }
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(source)
  return refs
}

export function collectRelativeImports(sourceText: string, fileRelative: string): string[] {
  const source = ts.createSourceFile(fileRelative, sourceText, ts.ScriptTarget.Latest, true)
  const specs: string[] = []
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
        specs.push(node.moduleSpecifier.text)
      }
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const first = node.arguments[0]
      if (first && ts.isStringLiteralLike(first)) {
        specs.push(first.text)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return specs
}

function resolveRelativeModule(fromFile: string, specifier: string, availableFiles: Set<string>): string | undefined {
  if (!specifier.startsWith(".")) return undefined
  const baseDir = path.posix.dirname(normalizeRel(fromFile))
  const stripped = specifier.replace(/\.[mc]?[jt]sx?$/, "")
  const joined = path.posix.normalize(path.posix.join(baseDir, stripped))
  const candidates = [
    joined,
    joined + ".ts",
    joined + ".tsx",
    joined + ".js",
    joined + ".jsx",
    joined + ".mjs",
    joined + ".cjs",
    joined + "/index.ts",
    joined + "/index.tsx",
    joined + "/index.js",
    path.posix.normalize(path.posix.join(baseDir, specifier)),
  ]
  for (const candidate of candidates) {
    if (availableFiles.has(candidate)) return candidate
  }
  return undefined
}

export function isTestOrHelperPath(
  relative: string,
  packageDir: string,
  prodImporters?: Map<string, Set<string>>,
): boolean {
  if (packageDir !== "." && !relative.startsWith(packageDir + "/")) return false
  const sub = packageDir === "." ? relative : relative.slice(packageDir.length + 1)
  if (isTestFile(relative)) return true
  if (
    sub.startsWith("test/") ||
    sub.startsWith("tests/") ||
    sub.startsWith("e2e/") ||
    sub.includes("/test/") ||
    sub.includes("/tests/") ||
    sub.includes("/fixture/") ||
    sub.includes("/fixtures/") ||
    sub.includes("__tests__/")
  ) {
    return true
  }
  const baseName = path.posix.basename(sub)
  if (/(?:^|[-_.])(?:test|spec|fixture|fixtures|mock|mocks|helper|helpers|harness)(?:[-_.]|\.)/i.test(baseName)) {
    return true
  }
  if (prodImporters && (prodImporters.get(relative)?.size ?? 0) === 0) {
    // Not imported by any non-test production source file in the package:
    // if reached from a test file, it is a test-dedicated helper.
    return true
  }
  return false
}

export function parseBunfigTestPreloads(bunfigText: string): { preloads: string[]; parseError?: string } {
  const lines = bunfigText.split(/\r?\n/)
  let section = "root"
  let rootPreloads: string[] | undefined
  let testPreloads: string[] | undefined

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]?.replace(/#.*$/, "").trim() ?? ""
    if (!raw) continue
    const secMatch = /^\[([^\]]+)\]$/.exec(raw)
    if (secMatch) {
      section = secMatch[1].trim()
      continue
    }
    if ((section === "root" || section === "test") && raw.startsWith("preload")) {
      const eq = raw.indexOf("=")
      if (eq === -1) return { preloads: [], parseError: `invalid preload line in bunfig.toml:${i + 1}` }
      let rhs = raw.slice(eq + 1).trim()
      while (rhs.startsWith("[") && !rhs.includes("]") && i + 1 < lines.length) {
        i += 1
        rhs += " " + (lines[i]?.replace(/#.*$/, "").trim() ?? "")
      }
      if (rhs.startsWith("[") && rhs.endsWith("]")) {
        const items: string[] = []
        const body = rhs.slice(1, -1).trim()
        if (body.length > 0) {
          for (const part of body.split(",")) {
            const trimmed = part.trim()
            if (!trimmed) continue
            const m = /^["']([^"']+)["']$/.exec(trimmed)
            if (!m) return { preloads: [], parseError: `invalid preload entry in bunfig.toml:${i + 1}` }
            items.push(m[1])
          }
        }
        if (section === "test") testPreloads = items
        else rootPreloads = items
      } else {
        const m = /^["']([^"']+)["']$/.exec(rhs)
        if (!m) return { preloads: [], parseError: `invalid preload value in bunfig.toml:${i + 1}` }
        if (section === "test") testPreloads = [m[1]]
        else rootPreloads = [m[1]]
      }
    }
  }

  return { preloads: testPreloads ?? rootPreloads ?? [] }
}

/**
 * Validate a candidate Home preload source text.
 *
 * A valid Home preload must:
 * 1. Assign `process.env.WOPAL_HOME` (or `process.env["WOPAL_HOME"]` / `bindWopalHome(...)`)
 *    at top level before any import or evaluation of `@wopal/ellamaka-core/global` or `src/` modules.
 * 2. Not assign `process.env.WOPAL_HOME` to itself (`process.env.WOPAL_HOME`), `os.homedir()`,
 *    `~/.wopal`, or a fixed non-temp literal path.
 * 3. Register an `afterAll` cleanup hook in the preload module.
 */
export function validateHomePreloadSource(
  preloadPath: string,
  sourceText: string,
): { valid: boolean; reason?: string } {
  const source = ts.createSourceFile(preloadPath, sourceText, ts.ScriptTarget.Latest, true)

  let assignIndex = -1
  let assignRhs: ts.Expression | undefined
  let earliestDynamicGlobalOrSrcImportIndex = Infinity
  let hasStaticGlobalOrSrcImport = false
  let hasAfterAllWithCleanup = false
  const localConstInitializers = new Map<string, ts.Expression>()

  for (let idx = 0; idx < source.statements.length; idx++) {
    const stmt = source.statements[idx]

    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.initializer) {
          localConstInitializers.set(decl.name.text, decl.initializer)
        }
      }
    }

    if (ts.isImportDeclaration(stmt) && ts.isStringLiteralLike(stmt.moduleSpecifier)) {
      if (!stmt.importClause?.isTypeOnly) {
        const spec = stmt.moduleSpecifier.text
        if (isHomeBoundImportSpecifier(spec) || spec.startsWith("../src/") || spec.startsWith("./src/")) {
          // ES static imports are hoisted and evaluated BEFORE any top-level statement in this module runs!
          hasStaticGlobalOrSrcImport = true
        }
      }
    }

    const walkStmt = (node: ts.Node, insideFunction: boolean) => {
      if (
        ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node)
      ) {
        insideFunction = true
      }

      if (ts.isCallExpression(node)) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          const arg = node.arguments[0]
          if (arg && ts.isStringLiteralLike(arg)) {
            const spec = arg.text
            if (
              !insideFunction &&
              (isHomeBoundImportSpecifier(spec) || spec.startsWith("../src/") || spec.startsWith("./src/"))
            ) {
              earliestDynamicGlobalOrSrcImportIndex = Math.min(earliestDynamicGlobalOrSrcImportIndex, idx)
            }
          }
        }
        if (ts.isIdentifier(node.expression) && node.expression.text === "afterAll") {
          const cb = node.arguments[0]
          const cbText = cb ? cb.getText(source) : ""
          if (/\b(?:rm|rmSync|rmdir|rmdirSync)\s*\(/.test(cbText)) {
            hasAfterAllWithCleanup = true
          }
        }
      }

      if (
        !insideFunction &&
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        isEnvMember(node.left) &&
        envKeyOf(source, node.left) === "WOPAL_HOME"
      ) {
        if (assignIndex === -1) {
          assignIndex = idx
          assignRhs = node.right
        }
      }

      ts.forEachChild(node, (child) => walkStmt(child, insideFunction))
    }

    walkStmt(stmt, false)
  }

  if (assignIndex === -1 || !assignRhs) {
    return { valid: false, reason: `${preloadPath} does not assign process.env.WOPAL_HOME at top level` }
  }

  if (hasStaticGlobalOrSrcImport) {
    return {
      valid: false,
      reason: `${preloadPath} has a static import of Global/src (hoisted before top-level WOPAL_HOME assignment); use dynamic import() after assigning WOPAL_HOME`,
    }
  }

  if (assignIndex >= earliestDynamicGlobalOrSrcImportIndex) {
    return {
      valid: false,
      reason: `${preloadPath} dynamically imports Global/src before top-level process.env.WOPAL_HOME assignment`,
    }
  }

  const resolvedExpr =
    ts.isIdentifier(assignRhs) && localConstInitializers.has(assignRhs.text)
      ? localConstInitializers.get(assignRhs.text)!
      : assignRhs
  const rhsText = resolvedExpr.getText(source).trim()
  const rawRhsText = assignRhs.getText(source).trim()

  // Reject identity or fallback-to-existing WOPAL_HOME assignment
  if (
    /process\.env(?:\.WOPAL_HOME|\[['"]WOPAL_HOME['"]\])/.test(rawRhsText) ||
    /process\.env(?:\.WOPAL_HOME|\[['"]WOPAL_HOME['"]\])/.test(rhsText)
  ) {
    return {
      valid: false,
      reason: `${preloadPath} assigns WOPAL_HOME from existing process.env.WOPAL_HOME instead of an unconditional isolated temp dir`,
    }
  }

  // Reject real home directory or tilde path
  if (/homedir\s*\(/.test(rhsText) || /['"`]~/.test(rhsText) || /\.wopal['"`]/.test(rhsText)) {
    return {
      valid: false,
      reason: `${preloadPath} assigns WOPAL_HOME to a real user home path (${rhsText})`,
    }
  }

  // Reject fixed string literal
  if (ts.isStringLiteralLike(resolvedExpr)) {
    return {
      valid: false,
      reason: `${preloadPath} assigns WOPAL_HOME to a fixed literal path (${rhsText}) instead of a process-unique temp dir`,
    }
  }

  // Require temp dir construct AND per-process/unique token (process.pid / mkdtemp / randomUUID).
  // `resolveTempRoot` is the vetted helper that returns a temp directory outside
  // every git checkout: a plain os.tmpdir() can point inside this workspace, and a
  // temp dir inside a repository makes worktree fixtures register in the real
  // checkout.
  const hasTmpDir = /(?:tmpdir\s*\(|mkdtemp|mkdtempSync|resolveTempRoot\s*\()/.test(rhsText)
  const hasUniqueToken = /(?:process\.pid|mkdtemp|mkdtempSync|randomUUID)/.test(rhsText)
  if (!hasTmpDir || !hasUniqueToken) {
    return {
      valid: false,
      reason: `${preloadPath} WOPAL_HOME target (${rhsText}) must derive a process-unique directory under os.tmpdir() (e.g. with process.pid or mkdtemp)`,
    }
  }

  if (!hasAfterAllWithCleanup) {
    return {
      valid: false,
      reason: `${preloadPath} does not register an afterAll cleanup hook (fs.rm / rmSync) for the isolated WOPAL_HOME`,
    }
  }

  return { valid: true }
}

function checkTestScriptOverridesPreload(
  scriptName: string,
  command: string,
  validPreloadRelPaths: Set<string>,
): string | undefined {
  if (!/\bbun\b.*\btest\b/.test(command)) return undefined
  const configMatch = /(?:\s|^)(?:-c|--config)(?:=|\s+)([^\s'"]+|'[^']+'|"[^"]+")/.exec(command)
  if (configMatch) {
    const cfg = configMatch[1].replace(/^['"]|['"]$/g, "").replace(/^\.\//, "")
    if (cfg !== "bunfig.toml") {
      return `package.json script "${scriptName}" passes --config ${configMatch[1]}, bypassing bunfig.toml Home preload`
    }
  }
  const preloadFlags = [...command.matchAll(/--preload(?:=|\s+)([^\s'"]+|'[^']+'|"[^"]+")/g)].map((m) =>
    m[1].replace(/^['"]|['"]$/g, "").replace(/^\.\//, ""),
  )
  if (preloadFlags.length > 0) {
    const includesValid = preloadFlags.some((p) => validPreloadRelPaths.has(p))
    if (!includesValid) {
      return `package.json script "${scriptName}" overrides --preload without including the package Home preload`
    }
  }
  return undefined
}

export function validatePackageHomeBase(
  packageDir: string,
  fs: GateFileSystem,
): { valid: boolean; issues: string[]; preloadFile?: string } {
  const issues: string[] = []
  const manifestPath = normalizeRel(path.posix.join(packageDir, "package.json"))
  const manifestRaw = fs.files.get(manifestPath)
  if (!manifestRaw) {
    return { valid: false, issues: [`missing ${manifestPath}`] }
  }

  let manifest: { name?: string; scripts?: Record<string, string> }
  try {
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    manifest = JSON.parse(manifestRaw) as { name?: string; scripts?: Record<string, string> }
  } catch {
    return { valid: false, issues: [`unreadable JSON in ${manifestPath}`] }
  }

  const bunfigPath = normalizeRel(path.posix.join(packageDir, "bunfig.toml"))
  const bunfigRaw = fs.files.get(bunfigPath)
  if (bunfigRaw === undefined) {
    return {
      valid: false,
      issues: [`${packageDir} has no bunfig.toml with [test].preload (reference: packages/opencode/test/preload.ts)`],
    }
  }

  const parsed = parseBunfigTestPreloads(bunfigRaw)
  if (parsed.parseError) {
    return { valid: false, issues: [`${bunfigPath}: ${parsed.parseError}`] }
  }
  if (parsed.preloads.length === 0) {
    return {
      valid: false,
      issues: [`${bunfigPath} defines no [test].preload entries (reference: packages/opencode/test/preload.ts)`],
    }
  }

  const validPreloadRelPaths = new Set<string>()
  let validPreloadFile: string | undefined
  let firstHomeBoundPreloadIdx = Infinity
  let firstValidHomePreloadIdx = Infinity

  for (let i = 0; i < parsed.preloads.length; i++) {
    const entry = parsed.preloads[i]
    if (!entry.startsWith(".")) continue
    const normalizedEntry = entry.replace(/^\.\//, "")
    const candidateRel = normalizeRel(path.posix.join(packageDir, normalizedEntry))
    const preloadSource =
      fs.files.get(candidateRel) ?? fs.files.get(candidateRel + ".ts") ?? fs.files.get(candidateRel + ".tsx")
    const resolvedPath = fs.files.has(candidateRel)
      ? candidateRel
      : fs.files.has(candidateRel + ".ts")
        ? candidateRel + ".ts"
        : fs.files.has(candidateRel + ".tsx")
          ? candidateRel + ".tsx"
          : undefined

    if (!preloadSource || !resolvedPath) {
      issues.push(`${bunfigPath} preload "${entry}" does not exist at ${candidateRel}`)
      continue
    }

    const validation = validateHomePreloadSource(resolvedPath, preloadSource)
    if (validation.valid) {
      validPreloadRelPaths.add(normalizedEntry)
      validPreloadRelPaths.add(path.posix.relative(packageDir, resolvedPath))
      validPreloadFile = resolvedPath
      firstValidHomePreloadIdx = Math.min(firstValidHomePreloadIdx, i)
    } else {
      const refs = scanHomeBindingsInSource(resolvedPath, preloadSource)
      if (refs.length > 0) {
        firstHomeBoundPreloadIdx = Math.min(firstHomeBoundPreloadIdx, i)
      }
      if (normalizedEntry.includes("preload")) {
        issues.push(validation.reason ?? `${resolvedPath} is not a valid Home preload`)
      }
    }
  }

  if (!validPreloadFile) {
    if (issues.length === 0) {
      issues.push(
        `${bunfigPath} preloads (${parsed.preloads.join(", ")}) do not include a valid Home preload (reference: packages/opencode/test/preload.ts)`,
      )
    }
    return { valid: false, issues }
  }

  if (firstHomeBoundPreloadIdx < firstValidHomePreloadIdx) {
    issues.push(`${bunfigPath} loads a preload referencing Global/Home-bound state before ${validPreloadFile}`)
    return { valid: false, issues }
  }

  const scripts = manifest.scripts ?? {}
  for (const [name, cmd] of Object.entries(scripts)) {
    if (!name.startsWith("test")) continue
    const overrideErr = checkTestScriptOverridesPreload(name, cmd, validPreloadRelPaths)
    if (overrideErr) issues.push(`${manifestPath}: ${overrideErr}`)
  }

  return { valid: issues.length === 0, issues, preloadFile: validPreloadFile }
}

function findOwningPackageDir(fileRelative: string, packageDirs: string[]): string | undefined {
  let best: string | undefined
  for (const dir of packageDirs) {
    if (dir === ".") {
      if (!best) best = "."
      continue
    }
    if (fileRelative.startsWith(dir + "/")) {
      if (!best || dir.length > best.length) best = dir
    }
  }
  return best
}

/**
 * Scan a repository / virtual file map for package-level Home isolation (TISO009)
 * alongside per-file rules (TISO001-TISO008).
 */
export function scanRepository(
  fs: GateFileSystem,
  root = "/repo",
): {
  violations: Violation[]
  packages: PackageDiscovery[]
  testFiles: string[]
} {
  const allPaths = [...fs.files.keys()].map(normalizeRel).sort()
  const availableFiles = new Set(allPaths)

  const packageDirs: string[] = []
  for (const p of allPaths) {
    if (p === "package.json") {
      packageDirs.push(".")
    } else if (p.endsWith("/package.json")) {
      const dir = p.slice(0, -"/package.json".length)
      packageDirs.push(dir)
    }
  }

  const testFiles = allPaths.filter((p) => isTestFile(p))
  const violations: Violation[] = []

  for (const file of testFiles) {
    const content = fs.files.get(file) ?? ""
    violations.push(...scanSource(file, content, { root }))
  }

  const byPackage = new Map<string, string[]>()
  for (const testFile of testFiles) {
    const pkgDir = findOwningPackageDir(testFile, packageDirs) ?? "."
    const list = byPackage.get(pkgDir) ?? []
    list.push(testFile)
    byPackage.set(pkgDir, list)
  }

  const packages: PackageDiscovery[] = []

  for (const [pkgDir, pkgTestFiles] of [...byPackage.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const manifestPath = pkgDir === "." ? "package.json" : `${pkgDir}/package.json`
    let packageName = pkgDir
    try {
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
      const parsed = JSON.parse(fs.files.get(manifestPath) ?? "{}") as { name?: string }
      if (parsed.name) packageName = parsed.name
    } catch {
      // handled in validatePackageHomeBase
    }

    // Build reverse import map for non-test files inside this package so we can
    // distinguish shared production modules from test-only helpers under src/.
    const prodImporters = new Map<string, Set<string>>()
    for (const candidate of allPaths) {
      if (findOwningPackageDir(candidate, packageDirs) !== pkgDir) continue
      if (isTestFile(candidate) || isTestOrHelperPath(candidate, pkgDir)) continue
      if (!/\.(?:[cm]?[jt]s|[jt]sx)$/.test(candidate)) continue
      const content = fs.files.get(candidate)
      if (!content) continue
      for (const spec of collectRelativeImports(content, candidate)) {
        const resolved = resolveRelativeModule(candidate, spec, availableFiles)
        if (!resolved) continue
        const set = prodImporters.get(resolved) ?? new Set<string>()
        set.add(candidate)
        prodImporters.set(resolved, set)
      }
    }

    // BFS from test entries through relative imports within the package
    const queue = [...pkgTestFiles]
    const visited = new Set<string>(pkgTestFiles)
    const reachableHelpers: string[] = []

    while (queue.length > 0) {
      const current = queue.shift()!
      const content = fs.files.get(current)
      if (!content) continue
      const specs = collectRelativeImports(content, current)
      for (const spec of specs) {
        const resolved = resolveRelativeModule(current, spec, availableFiles)
        if (!resolved || visited.has(resolved)) continue
        if (findOwningPackageDir(resolved, packageDirs) !== pkgDir) continue
        const sub = pkgDir === "." ? resolved : resolved.slice(pkgDir.length + 1)
        const activeProdImporters = prodImporters.get(resolved)
        const hasRemainingProdImporters =
          activeProdImporters !== undefined && [...activeProdImporters].some((imp) => !visited.has(imp))
        const isSharedProductionSrc =
          sub.startsWith("src/") && !isTestOrHelperPath(resolved, pkgDir) && hasRemainingProdImporters
        if (!isSharedProductionSrc) {
          visited.add(resolved)
          if (!isTestFile(resolved)) reachableHelpers.push(resolved)
          queue.push(resolved)
        }
      }
    }

    // Also include any standalone helper files in <pkgDir>/test/fixture(s) that tests spawn via subprocess
    for (const candidate of allPaths) {
      if (findOwningPackageDir(candidate, packageDirs) !== pkgDir) continue
      if (visited.has(candidate)) continue
      if (!/\.(?:[cm]?[jt]s|[jt]sx)$/.test(candidate)) continue
      if (isTestOrHelperPath(candidate, pkgDir) && !isTestFile(candidate)) {
        visited.add(candidate)
        reachableHelpers.push(candidate)
      }
    }

    reachableHelpers.sort()
    const homeBindings: HomeBindingRef[] = []
    for (const file of [...pkgTestFiles, ...reachableHelpers]) {
      const content = fs.files.get(file)
      if (!content) continue
      homeBindings.push(...scanHomeBindingsInSource(file, content))
    }

    const baseCheck =
      pkgDir === "." ? { valid: false, issues: ["root has no Home preload"] } : validatePackageHomeBase(pkgDir, fs)

    packages.push({
      packageDir: pkgDir,
      packageName,
      testFiles: pkgTestFiles,
      reachableHelpers,
      homeBindings,
      preloadValid: baseCheck.valid,
      preloadIssues: baseCheck.issues,
    })

    if (homeBindings.length > 0 && !baseCheck.valid) {
      const reason = baseCheck.issues[0] ?? `${pkgDir} lacks a valid Home preload`
      for (const ref of homeBindings) {
        violations.push({
          rule: "TISO009",
          file: ref.file,
          line: ref.line,
          detail: `${packageName} (${pkgDir}): ${ref.target} [${reason}]`,
        })
      }
    }
  }

  return { violations, packages, testFiles }
}
