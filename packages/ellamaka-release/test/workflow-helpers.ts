// packages/ellamaka-release/test/workflow-helpers.ts
//
// Shared helpers for the release workflow assertions. The CLI and Desktop
// publish workflows must place the npm publish step the same way (gated on a
// real release, before the immutable R2 commit point), so the extraction and
// counting live here instead of being re-derived per test file.

/** Number of non-overlapping occurrences of `needle` in `text`. */
export function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1
}

/**
 * The YAML block of the step containing `marker`, from the step's own
 * `- name:` / `- uses:` line up to (excluding) `marker`.
 *
 * Fails loudly when the marker or its step header is missing, so a moved or
 * renamed step cannot silently satisfy a `toContain` assertion elsewhere.
 */
export function stepBlockBefore(workflow: string, marker: string): string {
  const markerIndex = workflow.indexOf(marker)
  if (markerIndex < 0) throw new Error(`workflow step marker not found: ${marker}`)
  const headerIndex = workflow.lastIndexOf("\n      - ", markerIndex)
  if (headerIndex < 0) throw new Error(`workflow step header not found before: ${marker}`)
  return workflow.slice(headerIndex, markerIndex)
}

/** A workflow step as parsed from YAML (only the fields the contracts read). */
export type WorkflowStep = {
  name?: string
  uses?: string
  run?: string
  with?: Record<string, unknown>
  if?: string
  "continue-on-error"?: boolean
}

/** A job as parsed from YAML (only the fields the contracts read). */
export type WorkflowJob = {
  "runs-on"?: string
  uses?: string
  needs?: string | string[]
  steps?: WorkflowStep[]
  strategy?: unknown
  if?: string
}

/** A workflow document as parsed from YAML. */
export type Workflow = {
  on?: Record<string, unknown>
  concurrency?: Record<string, unknown>
  jobs: Record<string, WorkflowJob>
}

/**
 * Parse a workflow file with Bun's YAML parser. Contracts assert on the real
 * document structure instead of substring matches, so a trigger added under a
 * different spelling still fails them.
 */
export function parseWorkflow(text: string): Workflow {
  // Bun.YAML.parse is untyped by design; the contracts below validate every
  // field they read, so this assertion only names the parsed shape.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return Bun.YAML.parse(text) as Workflow
}

/** A job by name, failing loudly when the workflow does not declare it. */
export function getJob(workflow: Workflow, name: string): WorkflowJob {
  const job = workflow.jobs[name]
  if (!job) throw new Error(`workflow job not found: ${name}`)
  return job
}

/** The job's steps, failing loudly when the job has none. */
export function jobSteps(job: WorkflowJob, jobName: string): WorkflowStep[] {
  const steps = job.steps
  if (!steps) throw new Error(`workflow job has no steps: ${jobName}`)
  return steps
}

/**
 * Index of the first step whose `run`/`uses` includes `needle`.
 *
 * Fails loudly when the step is missing, so deleting a gate step cannot leave
 * an ordering assertion silently satisfied by a later one.
 */
export function indexOfStep(job: WorkflowJob, jobName: string, needle: string): number {
  const steps = jobSteps(job, jobName)
  const index = steps.findIndex((step) => step.run?.includes(needle) || step.uses?.includes(needle))
  if (index < 0) throw new Error(`workflow step not found in ${jobName}: ${needle}`)
  return index
}

/** Assert `needles` appear as distinct steps in strictly increasing order. */
export function expectStepOrder(job: WorkflowJob, jobName: string, needles: string[]): number[] {
  const indexes = needles.map((needle) => indexOfStep(job, jobName, needle))
  for (let i = 1; i < indexes.length; i++) {
    const previous = indexes[i - 1]
    const current = indexes[i]
    if (previous === undefined || current === undefined || current <= previous) {
      throw new Error(`workflow steps out of order in ${jobName}: ${needles.join(" -> ")} became ${indexes.join(",")}`)
    }
  }
  return indexes
}
