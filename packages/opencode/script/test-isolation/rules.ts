/**
 * Rule definitions for the test isolation gate.
 *
 * Every rule has a stable id, a machine-detectable pattern, and a message that
 * says what to do instead. The rules are the executable half of
 * docs/testing-isolation.md; the prose half lives in the root AGENTS.md.
 */

export type RuleId =
  | "TISO001" // ordinary test calls mock.module
  | "TISO002" // test mutates process.env directly
  | "TISO003" // test waits on a fixed delay instead of a readiness signal
  | "TISO004" // unit layer performs live I/O
  | "TISO005" // .only, or a newly added .skip / .todo
  | "TISO006" // test writes a shared path without an owning fixture
  | "TISO007" // baseline entry no longer matches any source violation
  | "TISO008" // ordinary test enables in-process concurrent execution

export type Rule = {
  id: RuleId
  title: string
  message: string
}

export const RULES: Record<RuleId, Rule> = {
  TISO001: {
    id: "TISO001",
    title: "ordinary test replaces a module with mock.module",
    message:
      "mock.module is process-wide and is not undone by mock.restore(), so it leaks into every test file " +
      "loaded later. Inject the dependency instead (a service, a factory, Layer.mock). " +
      "If the module reads env or config at import time, or you are testing a module loader, " +
      "run the test in its own process.",
  },
  TISO002: {
    id: "TISO002",
    title: "test mutates process.env directly",
    message:
      "Process-wide environment changes leak into every later test file. Use the owning package's " +
      "test/fixture/process-env.ts scopedEnv helper (add the same package-local helper first if absent). " +
      "A library that reads process.env at import time needs an explicit input or a separate process.",
  },
  TISO003: {
    id: "TISO003",
    title: "test waits on a fixed delay instead of a readiness signal",
    message:
      "A fixed delay is not synchronization: it times out on a slow machine and wastes time on a fast " +
      "one. Await the operation's Promise or a published readiness signal; if the code returns void while " +
      "starting async work, expose a completion Promise/callback seam. Keep timeouts only as failure backstops.",
  },
  TISO004: {
    id: "TISO004",
    title: "unit-layer test performs live I/O",
    message:
      "The unit layer must stay in-process and deterministic. Move the test into the integration layer " +
      "(an INTEGRATION_DIRS directory, or the -integration.test.ts suffix).",
  },
  TISO005: {
    id: "TISO005",
    title: "test adds a skip, a todo, or a focused test",
    message: "test.only is forbidden. A new test.skip or test.todo hides a real failure; fix the cause instead.",
  },
  TISO006: {
    id: "TISO006",
    title: "test writes a shared path without an owning fixture",
    message:
      "A test that writes a shared path must own it and release exactly what it wrote. Use the package " +
      "fixture (tmpdir and friends) so concurrent fixtures cannot clear each other's state.",
  },
  TISO007: {
    id: "TISO007",
    title: "baseline entry does not match any source violation",
    message:
      "This violation was fixed but the baseline entry was kept. Remove the stale entry; the baseline may " +
      "only shrink.",
  },
  TISO008: {
    id: "TISO008",
    title: "ordinary test directly enables Bun in-process concurrent execution",
    message:
      "Direct bun:test test.concurrent / describe.concurrent calls share process.env, module state, caches, " +
      "listeners and filesystem globals with other tests. Keep ordinary direct controls serial. If concurrency " +
      "is needed, create it inside one test with explicitly owned dependencies, use a documented owner-aware " +
      "package helper, or isolate each worker in a separate process.",
  },
}

/**
 * Files that are allowed to replace modules wholesale.
 *
 * A fixed process preload runs before any test file and owns its mocks for the
 * whole process by design. It is an architectural exception, not debt, and it
 * is never listed in the baseline.
 */
export const ALLOWED_MODULE_REPLACERS = ["packages/ellamaka-desktop/electron-mock.ts"]

/**
 * The integration boundary, derived from the real runner configuration.
 *
 * The gate must never keep its own opinion about which tests are integration
 * tests: a hand-written allowlist silently drifts and starts exempting unit
 * tests. Every entry below is copied from a source of truth that CI runs:
 *
 *   packages/opencode/script/run-tests.ts -> INTEGRATION_DIRS
 *   packages/ellamaka-cordis/package.json -> test:integration file list
 *
 * The -integration.test.ts and -e2e.test.ts suffixes are layer markers and need
 * no entry here. scan.test.ts asserts this list still matches the runner
 * configuration, so drift fails the gate instead of weakening it.
 */
export const INTEGRATION_ROOTS = [
  "packages/ellamaka-desktop/e2e",
  "packages/opencode/test/server",
  "packages/opencode/test/session",
  "packages/opencode/test/cli",
  "packages/opencode/test/project",
  "packages/opencode/test/tool",
  "packages/opencode/test/control-plane",
  "packages/opencode/test/plugin",
  "packages/opencode/test/file",
  "packages/opencode/test/pty",
  "packages/opencode/test/skill",
  "packages/opencode/test/reference",
  "packages/opencode/test/share",
  "packages/opencode/test/mcp",
  "packages/opencode/test/lsp",
  "packages/opencode/test/publish-smoke",
]

/**
 * Individual test files that a package runs as integration while the rest of
 * its test directory stays unit. Listed per package.json test:integration.
 */
export const INTEGRATION_FILES = [
  "packages/ellamaka-cordis/test/plugins-runtime.test.ts",
  "packages/ellamaka-cordis/test/dsh-web.test.ts",
  "packages/ellamaka-cordis/test/bun-ptc-runtime.test.ts",
  "packages/ellamaka-cordis/test/dsh-adapter-runtime.test.ts",
  "packages/ellamaka-cordis/test/bun-subprocess-stdio-integration.test.ts",
]
