import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  createCorePreparationService,
  type CorePreparationContributor,
  type CorePreparationEvent,
  type PreparationTarget,
} from "@wopal/ellamaka-core/preparation"

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function withTempDir<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ellamaka-preparation-"))
  try {
    return await run(root)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

function instanceDirectory(target: PreparationTarget): string {
  if (target.kind !== "instance") throw new Error("expected instance target")
  return target.directory
}

describe("CorePreparationService", () => {
  test("constructs without writes, keeps inspect read-only, and normalizes instance targets", async () => {
    await withTempDir(async (root) => {
      const marker = path.join(root, "prepared.txt")
      const seen: string[] = []
      const contributor: CorePreparationContributor = {
        step: "instance.files",
        target: "instance",
        async inspect(target) {
          seen.push(instanceDirectory(target))
          return { state: "NEEDS_PREPARATION" }
        },
        async prepare() {
          await fs.writeFile(marker, "prepared")
          return { state: "READY" }
        },
      }

      const before = await fs.readdir(root)
      const service = createCorePreparationService({ hostKey: "test-host", contributors: [contributor] })
      expect(await fs.readdir(root)).toEqual(before)

      const result = await service.inspect({ kind: "instance", directory: path.join(root, "nested", "..") })
      expect(result).toEqual({
        target: { kind: "instance", directory: path.resolve(root) },
        state: "NEEDS_PREPARATION",
        steps: [{ step: "instance.files", state: "NEEDS_PREPARATION" }],
      })
      expect(seen).toEqual([path.resolve(root)])
      expect(await fs.readdir(root)).toEqual(before)
      expect(
        await fs.stat(marker).then(
          () => true,
          () => false,
        ),
      ).toBe(false)
    })
  })

  test("rejects duplicate steps for the same target kind", () => {
    const contributor = (target: "host" | "instance"): CorePreparationContributor => ({
      step: "shared.step",
      target,
      async inspect() {
        return { state: "READY" }
      },
      async prepare() {
        return { state: "READY" }
      },
    })

    expect(() =>
      createCorePreparationService({ hostKey: "test-host", contributors: [contributor("host"), contributor("host")] }),
    ).toThrow("duplicate CorePreparation contributor step")
    expect(() =>
      createCorePreparationService({
        hostKey: "test-host",
        contributors: [contributor("host"), contributor("instance")],
      }),
    ).not.toThrow()
  })

  test("single-flights equivalent targets and reports real ordered progress", async () => {
    await withTempDir(async (root) => {
      const marker = path.join(root, "prepared.txt")
      let executions = 0
      const events: CorePreparationEvent[] = []
      const contributor: CorePreparationContributor = {
        step: "instance.files",
        target: "instance",
        async inspect() {
          return {
            state: await fs.stat(marker).then(
              () => "READY" as const,
              () => "NEEDS_PREPARATION" as const,
            ),
          }
        },
        async prepare(_target, context) {
          executions += 1
          context.report({ phase: "write.start", current: 0, total: 1, unit: "file" })
          await delay(20)
          await fs.writeFile(marker, "prepared")
          context.report({ phase: "write.committed", current: 1, total: 1, unit: "file" })
          return { state: "READY" }
        },
      }
      const service = createCorePreparationService({ hostKey: "test-host", contributors: [contributor] })

      const first = service.prepare(
        { target: { kind: "instance", directory: root }, reason: "test" },
        { onProgress: (event) => events.push(event) },
      )
      const second = service.prepare({
        target: { kind: "instance", directory: path.join(root, ".") },
      })
      const [left, right] = await Promise.all([first, second])

      expect(executions).toBe(1)
      expect(left).toEqual(right)
      expect(left.state).toBe("READY")
      expect(left.target).toEqual({ kind: "instance", directory: path.resolve(root) })
      expect(left.run?.runId).toBeTruthy()
      expect(left.run?.sequence).toBe(2)
      expect(left.run?.phase).toBe("write.committed")
      expect(events.map((event) => event.sequence)).toEqual([1, 2])
      expect(new Set(events.map((event) => event.runId)).size).toBe(1)
      expect(events[1].elapsedMs).toBeGreaterThanOrEqual(events[0].elapsedMs)
      expect(events[1].elapsedMs).toBeGreaterThan(0)
      expect(events.map(({ current, total, unit }) => ({ current, total, unit }))).toEqual([
        { current: 0, total: 1, unit: "file" },
        { current: 1, total: 1, unit: "file" },
      ])
    })
  })

  test("keeps host and instance targets isolated, including different directories", async () => {
    await withTempDir(async (root) => {
      const counts = { host: 0, instance: new Map<string, number>() }
      const host: CorePreparationContributor = {
        step: "host.files",
        target: "host",
        async inspect() {
          return { state: "NEEDS_PREPARATION" }
        },
        async prepare() {
          counts.host += 1
          await delay(10)
          return { state: "READY" }
        },
      }
      const instance: CorePreparationContributor = {
        step: "instance.files",
        target: "instance",
        async inspect() {
          return { state: "NEEDS_PREPARATION" }
        },
        async prepare(target) {
          const directory = instanceDirectory(target)
          counts.instance.set(directory, (counts.instance.get(directory) ?? 0) + 1)
          await delay(10)
          return { state: "READY" }
        },
      }
      const service = createCorePreparationService({ hostKey: "test-host", contributors: [host, instance] })
      const firstDir = path.join(root, "one")
      const secondDir = path.join(root, "two")

      await Promise.all([
        service.prepare({ target: { kind: "host" } }),
        service.prepare({ target: { kind: "instance", directory: firstDir } }),
        service.prepare({ target: { kind: "instance", directory: path.join(firstDir, ".") } }),
        service.prepare({ target: { kind: "instance", directory: secondDir } }),
      ])

      expect(counts.host).toBe(1)
      expect(counts.instance).toEqual(
        new Map([
          [path.resolve(firstDir), 1],
          [path.resolve(secondDir), 1],
        ]),
      )
    })
  })

  test("exposes the active run snapshot without turning inspection into cancellation", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const contributor: CorePreparationContributor = {
      step: "host.wait",
      target: "host",
      async inspect() {
        return { state: "NEEDS_PREPARATION" }
      },
      async prepare(_target, context) {
        context.report({ phase: "wait.started" })
        await gate
        return { state: "READY" }
      },
    }
    const service = createCorePreparationService({ hostKey: "test-host", contributors: [contributor] })
    const running = service.prepare({ target: { kind: "host" } })
    await delay(0)

    const snapshot = await service.inspect({ kind: "host" })
    expect(snapshot.state).toBe("PREPARING")
    expect(snapshot.run?.step).toBe("host.wait")
    expect(snapshot.run?.phase).toBe("wait.started")
    expect(snapshot.run?.sequence).toBe(1)

    release()
    expect(await running).toMatchObject({ state: "READY" })
  })

  test("re-emits the current real phase as a heartbeat while preparation stays busy", async () => {
    const events: CorePreparationEvent[] = []
    const contributor: CorePreparationContributor = {
      step: "host.slow",
      target: "host",
      async inspect() {
        return { state: "NEEDS_PREPARATION" }
      },
      async prepare(_target, context) {
        context.report({ phase: "download" })
        await delay(35)
        return { state: "READY" }
      },
    }
    const service = createCorePreparationService({
      hostKey: "test-host",
      contributors: [contributor],
      heartbeatMs: 10,
    })

    await service.prepare({ target: { kind: "host" } }, { onProgress: (event) => events.push(event) })

    expect(events.length).toBeGreaterThanOrEqual(3)
    expect(events.every((event) => event.step === "host.slow" && event.phase === "download")).toBe(true)
    expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1))
    expect(events.at(-1)!.elapsedMs).toBeGreaterThan(events[0].elapsedMs)
  })

  test("does not let progress observers fail or cancel the shared preparation", async () => {
    let executions = 0
    const contributor: CorePreparationContributor = {
      step: "host.progress",
      target: "host",
      async inspect() {
        return { state: "NEEDS_PREPARATION" }
      },
      async prepare(_target, context) {
        executions += 1
        context.report({ phase: "started" })
        await delay(10)
        context.report({ phase: "finished" })
        return { state: "READY" }
      },
    }
    const service = createCorePreparationService({ hostKey: "test-host", contributors: [contributor] })

    const [observed, unobserved] = await Promise.all([
      service.prepare(
        { target: { kind: "host" } },
        {
          onProgress: () =>
            void (() => {
              throw new Error("observer failed")
            })(),
        },
      ),
      service.prepare({ target: { kind: "host" } }),
    ])

    expect(executions).toBe(1)
    expect(observed.state).toBe("READY")
    expect(unobserved).toEqual(observed)
  })

  test("preserves failure codes, releases file-backed work, and allows a later retry", async () => {
    await withTempDir(async (root) => {
      const lock = path.join(root, "failure.lock")
      const completed = path.join(root, "completed.txt")
      let attempts = 0
      const contributor: CorePreparationContributor = {
        step: "host.retry",
        target: "host",
        async inspect() {
          return { state: "NEEDS_PREPARATION" }
        },
        async prepare() {
          attempts += 1
          await fs.writeFile(lock, "held")
          try {
            if (attempts === 1) {
              throw Object.assign(new Error("temporary failure"), { code: "TEMPORARY_FAILURE" })
            }
            await fs.writeFile(completed, "done")
            return { state: "READY" }
          } finally {
            await fs.rm(lock, { force: true })
          }
        },
      }
      const service = createCorePreparationService({ hostKey: "test-host", contributors: [contributor] })

      const failureEvents: CorePreparationEvent[] = []
      expect(
        await service.prepare({ target: { kind: "host" } }, { onProgress: (event) => failureEvents.push(event) }),
      ).toMatchObject({
        state: "DEGRADED",
        reason: "TEMPORARY_FAILURE",
        steps: [{ step: "host.retry", state: "DEGRADED", code: "TEMPORARY_FAILURE" }],
      })
      expect(failureEvents.at(-1)).toMatchObject({
        step: "host.retry",
        phase: "failed",
        state: "DEGRADED",
        code: "TEMPORARY_FAILURE",
      })
      expect(
        await fs.stat(lock).then(
          () => true,
          () => false,
        ),
      ).toBe(false)

      expect(await service.prepare({ target: { kind: "host" } })).toMatchObject({ state: "READY" })
      expect(await fs.readFile(completed, "utf8")).toBe("done")
      expect(
        await fs.stat(lock).then(
          () => true,
          () => false,
        ),
      ).toBe(false)
      expect(attempts).toBe(2)
    })
  })

  test("cancels shared file-backed work only after its safe commit checkpoint", async () => {
    await withTempDir(async (root) => {
      const lock = path.join(root, "commit.lock")
      const committed = path.join(root, "committed.txt")
      let attempts = 0
      let commitStarted!: () => void
      const started = new Promise<void>((resolve) => {
        commitStarted = resolve
      })
      let releaseCommit!: () => void
      const commitGate = new Promise<void>((resolve) => {
        releaseCommit = resolve
      })
      const contributor: CorePreparationContributor = {
        step: "host.commit",
        target: "host",
        async inspect() {
          return { state: "NEEDS_PREPARATION" }
        },
        async prepare(_target, context) {
          attempts += 1
          await fs.writeFile(lock, "held")
          try {
            context.report({ phase: "commit.started" })
            if (attempts === 1) {
              commitStarted()
              await commitGate
            }
            await fs.writeFile(committed, `attempt-${attempts}`)
            context.report({ phase: "commit.finished" })
            return { state: "READY" }
          } finally {
            await fs.rm(lock, { force: true })
          }
        },
      }
      const service = createCorePreparationService({ hostKey: "test-host", contributors: [contributor] })
      const controller = new AbortController()
      let settled = false
      const first = service.prepare({ target: { kind: "host" } }, { signal: controller.signal }).finally(() => {
        settled = true
      })

      await started
      controller.abort()
      await delay(10)
      expect(settled).toBe(false)
      expect(await fs.readFile(lock, "utf8")).toBe("held")
      expect(
        await fs.stat(committed).then(
          () => true,
          () => false,
        ),
      ).toBe(false)

      releaseCommit()
      expect(await first).toMatchObject({
        state: "DEGRADED",
        reason: "PREPARATION_CANCELLED",
        steps: [{ step: "host.commit", state: "DEGRADED", code: "PREPARATION_CANCELLED" }],
      })
      expect(await fs.readFile(committed, "utf8")).toBe("attempt-1")
      expect(
        await fs.stat(lock).then(
          () => true,
          () => false,
        ),
      ).toBe(false)

      expect(await service.prepare({ target: { kind: "host" } })).toMatchObject({ state: "READY" })
      expect(await fs.readFile(committed, "utf8")).toBe("attempt-2")
      expect(
        await fs.stat(lock).then(
          () => true,
          () => false,
        ),
      ).toBe(false)
      expect(attempts).toBe(2)
    })
  })
})
