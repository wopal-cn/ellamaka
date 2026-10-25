/**
 * Static scanner behind the test isolation gate.
 *
 * The scanner reads TypeScript sources with the compiler API and reports every
 * pattern the isolation rules forbid. It deliberately reports facts about the
 * source, not judgements about intent: the baseline holds the known debt, and
 * anything the scanner finds outside the baseline is a new violation.
 */

import ts from "typescript"
import { ALLOWED_MODULE_REPLACERS, INTEGRATION_ROOTS, type RuleId } from "./rules"

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

const TEST_FILE = /\.test\.(?:ts|tsx)$/

/** Files that define a shared fixture or preload rather than a test case. */
const FIXTURE_LIKE = /(?:^|\/)(?:fixture|fixtures|preload|setup|helpers?)\//

export function isTestFile(relative: string) {
  return TEST_FILE.test(relative)
}

export function isIntegrationLayer(relative: string) {
  if (/-integration\.test\.(?:ts|tsx)$/.test(relative)) return true
  return INTEGRATION_ROOTS.some((root) => relative.startsWith(root + "/"))
}

/**
 * A file may replace modules when it is a shared fixture or an approved
 * process preload. Those files own their mocks for every consumer by design.
 */
function mayReplaceModules(relative: string) {
  if (ALLOWED_MODULE_REPLACERS.includes(relative)) return true
  if (!FIXTURE_LIKE.test(relative)) return false
  // A fixture still has to be referenced by the package that preloads it; the
  // preload file itself is the only one allowed to replace modules.
  return /preload\.(?:ts|tsx)$/.test(relative)
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

function isLiveIoCall(node: ts.CallExpression) {
  const callee = node.expression
  if (!ts.isPropertyAccessExpression(callee)) return false
  const owner = callee.expression
  const ownerName = ts.isIdentifier(owner) ? owner.text : undefined
  if (ownerName === "Bun" && LIVE_IO_CALLS.has(callee.name.text)) return true
  if (ownerName === "fs" && callee.name.text === "watch") return true
  if (ownerName === "fs" && callee.name.text === "watchFile") return true
  if (ownerName === "node:fs" && callee.name.text === "watch") return true
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

export function scanSource(relative: string, sourceText: string, _options: ScannerOptions): Violation[] {
  const violations: Violation[] = []
  if (!isTestFile(relative)) return violations
  const isIntegration = isIntegrationLayer(relative)
  const canReplaceModules = mayReplaceModules(relative)

  const source = ts.createSourceFile(relative, sourceText, ts.ScriptTarget.Latest, true)
  const lineOf = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1

  const report = (rule: RuleId, node: ts.Node, detail: string) => {
    violations.push({ rule, file: relative, line: lineOf(node), detail })
  }

  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      const calleeMember = ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined

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
      if (isFixedWaitCall(node) || isEffectSleep(node) || isBuiltinSleep(node)) {
        if (waitsForTime(node)) report("TISO003", node, textOf(source, node).slice(0, 80))
      }

      // TISO004 - live I/O in the unit layer
      if (!isIntegration && isLiveIoCall(node)) {
        report("TISO004", node, textOf(source, node).slice(0, 80))
      }

      // TISO005 - .only / .skip / .todo
      if (calleeMember === "only") {
        report("TISO005", node, textOf(source, node).slice(0, 60))
      }
      if (calleeMember === "skip" || calleeMember === "todo") {
        report("TISO005", node, textOf(source, node).slice(0, 60))
      }
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
      if (calleeMember === "writeFile" || calleeMember === "writeFileSync" || calleeMember === "mkdir") {
        const first = node.arguments[0]
        const shared = globalPathMember(first)
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
