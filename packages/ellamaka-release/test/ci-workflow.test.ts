import { describe, expect, test } from "bun:test"
import { readFileSync } from "fs"
import { dirname, join, resolve } from "path"
import { fileURLToPath } from "url"
import { countOccurrences, expectStepOrder, getJob, indexOfStep, jobSteps, parseWorkflow } from "./workflow-helpers"

const currentDir = dirname(fileURLToPath(import.meta.url))
const root = resolve(currentDir, "..", "..", "..")
const workflowDir = join(root, ".github", "workflows")

const ciText = readFileSync(join(workflowDir, "ci.yml"), "utf8")
const ci = parseWorkflow(ciText)

describe("ci workflow — trigger and runner contract", () => {
  test("runs nightly/by hand and never runs directly on push or pull request", () => {
    // CI minutes are limited by an explicit product decision: the nightly
    // suite and the manual run are the only entry points. Release packaging
    // has its own fixed safety gate instead of re-running this whole suite.
    expect(Object.keys(ci.on ?? {}).sort()).toEqual(["schedule", "workflow_dispatch"])
    const schedule = ci.on?.schedule
    expect(Array.isArray(schedule)).toBe(true)
    if (Array.isArray(schedule)) expect(schedule).toHaveLength(1)
    expect(ciText).toMatch(/- cron: "\d+ \d+ \* \* \*"/)
    expect(ciText).not.toMatch(/^\s{2}pull_request:/m)
    expect(ciText).not.toMatch(/^\s{2}push:/m)
  })

  test("declares Linux runners only — no macOS or Windows job", () => {
    const runners = Object.values(ci.jobs).map((job) => job["runs-on"])
    expect(runners.length).toBeGreaterThan(0)
    for (const runner of runners) expect(runner).toBe("ubuntu-24.04")
    expect(ciText).not.toMatch(/macos|windows/i)
  })

  test("nothing in the nightly workflow is allowed to fail without failing the run", () => {
    expect(ciText).not.toContain("continue-on-error")
    expect(ciText).not.toContain("|| true")
    expect(ciText).not.toContain("if: always()")
  })
})

describe("ci workflow — jobs", () => {
  test("nightly test:ci reaches every Cordis upgrade safety contract", () => {
    const pkg = JSON.parse(readFileSync(join(root, "packages/ellamaka-cordis/package.json"), "utf8"))
    expect(pkg.scripts["test:ci"]).toBe(
      `mkdir -p test-results/unit && ${pkg.scripts["test:contracts"]} --reporter=junit --reporter-outfile=test-results/unit/junit.xml`,
    )
    for (const suite of [
      "src/runtime/home-generation.test.ts",
      "src/runtime/home-guard.test.ts",
      "script/check-dsh-home-generation.test.ts",
      "script/upgrade-dsh.test.ts",
      "test/bun-subprocess.test.ts",
      "test/bun-subprocess-child.test.ts",
    ])
      expect(pkg.scripts["test:contracts"]).toContain(suite)
  })

  test("checks job installs, typechecks, lints, then runs the packages' test:ci scripts", () => {
    const job = getJob(ci, "checks")
    expectStepOrder(job, "checks", ["bun install", "bun run typecheck", "bun run lint", "turbo run test:ci"])
    expect(indexOfStep(job, "checks", "turbo run test:ci")).toBe(jobSteps(job, "checks").length - 1)
  })

  test("slow job probes the sandbox before the real DSH tool tests", () => {
    const job = getJob(ci, "slow")
    expect(job["runs-on"]).toBe("ubuntu-24.04")
    // The slow job must not become a multi-platform matrix.
    expect(job.strategy).toBeUndefined()
    expectStepOrder(job, "slow", [
      "scripts/ci/prepare-dsh-sandbox.sh",
      "bun run --cwd packages/ellamaka-cordis test:tools",
    ])
    const tools = jobSteps(job, "slow").find((step) => step.run?.includes("test:tools"))
    // A probe failure must not be routed around by a condition.
    expect(tools?.if).toBeUndefined()
    expect(tools?.["continue-on-error"]).toBeUndefined()
  })

  test("slow job is the only place the DSH tool tests run in the nightly workflow", () => {
    expect(countOccurrences(ciText, "test:tools")).toBe(1)
    expect(countOccurrences(ciText, "scripts/ci/prepare-dsh-sandbox.sh")).toBe(1)
  })
})

const publishWorkflows = [
  { label: "CLI", file: "publish-ellamaka-cli.yml", buildJob: "build-and-release" },
  { label: "Desktop", file: "publish-ellamaka-desktop.yml", buildJob: "build-desktop" },
] as const

const gateSteps = [
  "scripts/ci/prepare-dsh-sandbox.sh",
  "generate-dsh-runtime-manifest.ts --check",
  "generate-dsh-runtime-lock.ts --check",
  "check-dsh-home-generation.ts",
  "bun run --cwd packages/ellamaka-cordis test:contracts",
  "bun run --cwd packages/ellamaka-cordis test:tools",
]

for (const target of publishWorkflows) {
  const text = readFileSync(join(workflowDir, target.file), "utf8")
  const workflow = parseWorkflow(text)

  describe(`publish-${target.label.toLowerCase()} workflow — release gate`, () => {
    test("shares one repository-level release concurrency group", () => {
      // Both products resolve the same generation frontier, so their whole
      // release lifecycles must serialize. Pending runs queue without
      // replacing each other.
      expect(workflow.concurrency).toEqual({
        group: "ellamaka-release",
        "cancel-in-progress": false,
        queue: "max",
      })
    })

    test("every release-path checkout fetches full history and tags", () => {
      // The generation check resolves published frontiers from tags and
      // immutable manifests; a shallow checkout cannot see them.
      for (const [name, job] of Object.entries(workflow.jobs)) {
        if (name === "cleanup" || job.uses) continue
        const checkouts = jobSteps(job, name).filter((step) => step.uses?.startsWith("actions/checkout@"))
        expect(checkouts.length).toBeGreaterThan(0)
        for (const step of checkouts) expect(step.with?.["fetch-depth"]).toBe(0)
      }
    })

    test("runs the release safety gate directly after version validation", () => {
      expect(workflow.jobs["quality-gate"]).toBeUndefined()
      expect(text).not.toContain("uses: ./.github/workflows/ci.yml")
      const gate = getJob(workflow, "release-gate")
      expect(gate.needs).toBe("version")
    })

    test("gate runs the safety checks in the fixed order on ubuntu-24.04", () => {
      const gate = getJob(workflow, "release-gate")
      expect(gate["runs-on"]).toBe("ubuntu-24.04")
      expect(gate.strategy).toBeUndefined()
      expectStepOrder(gate, "release-gate", gateSteps)
    })

    test("gate has no failure escape hatch", () => {
      const gate = getJob(workflow, "release-gate")
      const steps = jobSteps(gate, "release-gate")
      for (const step of steps) {
        expect(step["continue-on-error"]).toBeUndefined()
      }
      const scripts = steps.map((step) => step.run ?? "").join("\n")
      expect(scripts).not.toContain("|| true")
      expect(scripts).not.toContain("continue-on-error")
    })

    test("packaging waits for the gate and each release safety check runs exactly once", () => {
      const build = getJob(workflow, target.buildJob)
      expect(build.needs).toEqual(["version", "release-gate"])
      const buildRuns = jobSteps(build, target.buildJob)
        .map((step) => step.run ?? "")
        .join("\n")
      for (const step of gateSteps) {
        expect(countOccurrences(text, step)).toBe(1)
        expect(buildRuns).not.toContain(step)
      }
    })
  })
}
