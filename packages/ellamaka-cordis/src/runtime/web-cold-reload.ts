/**
 * The `dsh:web` cold-reload lifecycle (DESIGN.md#unified-reload--lifecycle).
 *
 * A code or package-version change cannot take effect through an in-process
 * remount — native `import()` and internal loaders both cache modules by
 * URL. Cold reload therefore rebuilds the web container inside a NEW
 * managed child process, following the fixed protocol:
 *
 *   drain → dispose → build → verify → publish → notify
 *
 * The HOST keeps the listening socket and the stable `/dsh` route mount;
 * this controller only swaps the request/upgrade handlers the mount points
 * at, so the browser-facing URL never changes. While a rebuild runs the
 * mount answers an explicit 503 (new requests are "temporarily
 * unavailable"); a drained old container is disposed only after the new one
 * publishes. A FAILED rebuild degrades the `dsh:web` unit alone: the mount
 * keeps answering 503, the host and every other unit (native sessions,
 * PTYs, `dsh:tools`) are untouched, and NO revision is published — no fake
 * revisions (Plan Task 9 Interface).
 *
 * The builder callback is the process boundary: production hosts inject an
 * implementation that spawns the child (bun spawn / Electron
 * utilityProcess), waits for its readiness, and verifies it; tests inject
 * an in-process fake. Lifecycle ownership (child kill on abort, Home lease
 * coverage) lives with that injected builder's host.
 */

/** A built web container as the controller sees it. */
export interface ColdRebuildContainer {
  /** Serve one already-prefix-stripped request; returns a test-observable token. */
  handleRequest(req: unknown, res: unknown): unknown
  /** Serve one upgrade. */
  handleUpgrade(req: unknown, socket: unknown, head: unknown): unknown
  /** Tear the container (and its child process) down. */
  dispose?(): Promise<void>
}

/** The result of one successful build, before publication. */
export interface ColdBuildCandidate {
  container: ColdRebuildContainer
  /** Publish = atomically swap the mount's live handler to this container. */
  publish(): void
}

/** The injected process boundary: build a fresh web container. */
export type ColdRebuildBuilder = (phase: { signal: AbortSignal }) => Promise<ColdBuildCandidate>

/** Structured logger seam. */
export interface ColdReloadLogger {
  info(message: string, extra?: Record<string, unknown>): void
  warn(message: string, extra?: Record<string, unknown>): void
  error(message: string, extra?: Record<string, unknown>): void
}

/** The handle for one successfully published container generation. */
export interface ColdRebuildHandle {
  readonly container: ColdRebuildContainer
  /** The unit revision this generation published (starts at 1). */
  readonly revision: number
}

export interface DshWebColdReloadOptions {
  build: ColdRebuildBuilder
  logger: ColdReloadLogger
  /** Invoked after each terminal rebuild outcome (publish or failure). */
  onRebuilt?: (result: { ok: true; revision: number } | { ok: false; error: string }) => void
}

/** A request routed to no live container answers with this explicit 503. */
function unavailable(res: { writeHead(n: number): unknown; end(): unknown }): void {
  res.writeHead(503)
  res.end()
}

/**
 * Owns the `dsh:web` unit's cold-reload lifecycle and its stable mount
 * handler. All state transitions happen under one serialized queue, so
 * concurrent rebuild requests coalesce into at most one pending rerun.
 */
export class DshWebColdReload {
  private readonly build: ColdRebuildBuilder
  private readonly logger: ColdReloadLogger
  private readonly onRebuilt?: DshWebColdReloadOptions["onRebuilt"]

  private live: { container: ColdRebuildContainer; revision: number } | undefined
  private oldContainers: ColdRebuildContainer[] = []
  private disposed = false
  private rebuilding = false
  private pending = false
  private chain: Promise<void> = Promise.resolve()
  private readonly abort = new AbortController()

  constructor(options: DshWebColdReloadOptions) {
    this.build = options.build
    this.logger = options.logger
    this.onRebuilt = options.onRebuilt
  }

  /** Whether a rebuild is currently in flight (test/diagnostics seam). */
  get rebuildInProgress(): boolean {
    return this.rebuilding
  }

  /** The published generation's revision; `0` before the first publish. */
  get revision(): number {
    return this.live?.revision ?? 0
  }

  /**
   * The STABLE mount handlers. The host mounts these once under `/dsh`;
   * rebuilds swap what they forward to without remounting.
   */
  requestHandler(): (req: unknown, res: { writeHead(n: number): unknown; end(): unknown }) => unknown {
    return (req, res) => {
      const live = this.live
      if (this.disposed || !live) {
        unavailable(res)
        return undefined
      }
      return live.container.handleRequest(req, res)
    }
  }

  upgradeHandler(): (req: unknown, socket: unknown, head: unknown) => void {
    return (req, socket, head) => {
      const live = this.live
      if (this.disposed || !live) {
        // No live container: drop the upgrade instead of stranding the
        // client. The socket is a Duplex at every real call site; this
        // defensive shape check keeps the controller honest about `unknown`.
        if (typeof socket === "object" && socket !== null && "destroy" in socket) {
          const destroy = (socket as Record<string, unknown>).destroy
          if (typeof destroy === "function") Reflect.apply(destroy, socket, [])
        }
        return
      }
      live.container.handleUpgrade(req, socket, head)
    }
  }

  /**
   * Build the first generation (idempotent): a mount that is never built
   * answers 503 until this resolves.
   */
  async ensureBuilt(): Promise<ColdRebuildHandle> {
    const existing = this.live
    if (existing) {
      return { container: existing.container, revision: existing.revision }
    }
    await this.enqueue(() => this.rebuildOnce())
    const published = this.live
    if (!published) throw new Error("dsh:web cold reload did not publish a container")
    return { container: published.container, revision: published.revision }
  }

  /**
   * One cold rebuild: drain → dispose(old, after publish) → build → verify →
   * publish → notify. Serialized; a call during a rebuild waits for the
   * in-flight one and then runs its own fresh observation.
   */
  async rebuild(): Promise<void> {
    await this.enqueue(() => this.rebuildOnce())
  }

  /** Serialize every lifecycle transition through one chain. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(task, task)
    this.chain = run.then(
      () => {},
      () => {},
    )
    return run
  }

  private async rebuildOnce(): Promise<void> {
    if (this.disposed) throw new Error("dsh:web cold reload is disposed")
    this.rebuilding = true
    const previous = this.live
    try {
      // drain: the old container keeps serving its in-flight connections
      // while the new one builds — the mount still points at it. The
      // explicit 503 window starts only when the old container is gone and
      // the new one is not yet published (see requestHandler live-swap).
      const candidate = await this.build({ signal: this.abort.signal })
      // verify happened inside the builder (readiness + probe); publish is
      // the atomic swap of the mount's live pointer.
      const nextRevision = (previous?.revision ?? 0) + 1
      candidate.publish()
      this.live = { container: candidate.container, revision: nextRevision }
      this.logger.info("dsh:web container published", { revision: nextRevision })
      this.onRebuilt?.({ ok: true, revision: nextRevision })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // Unit degradation: the failed unit answers 503 (no live container for
      // a first build; the previous generation is torn down below for a
      // failed replacement — its modules are stale by definition). No
      // revision is published.
      this.logger.error("dsh:web cold rebuild failed; unit degraded", { error: message })
      this.onRebuilt?.({ ok: false, error: message })
      if (previous) {
        try {
          await this.disposeContainer(previous.container)
        } catch (disposeError) {
          this.logger.warn("dsh:web old container dispose failed during degradation", {
            error: disposeError instanceof Error ? disposeError.message : String(disposeError),
          })
        }
        this.live = undefined
      }
      throw error
    } finally {
      this.rebuilding = false
    }
    // Dispose the PREVIOUS generation only after the new one published
    // (drain → dispose ordering): the old container finished its in-flight
    // work while the new one built.
    if (previous && this.live) {
      try {
        await this.disposeContainer(previous.container)
      } catch (error) {
        this.logger.warn("dsh:web old container dispose failed", {
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  private async disposeContainer(container: ColdRebuildContainer): Promise<void> {
    const d = container as ColdRebuildContainer & { disposed?: boolean; dispose?(): Promise<void> }
    d.disposed = true
    if (typeof d.dispose === "function") await d.dispose()
  }

  /** Stop the unit: abort in-flight builds, dispose the live container. */
  async dispose(): Promise<void> {
    await this.enqueue(async () => {
      if (this.disposed) return
      this.disposed = true
      this.abort.abort()
      const live = this.live
      this.live = undefined
      if (live) {
        try {
          await this.disposeContainer(live.container)
        } catch (error) {
          this.logger.warn("dsh:web container dispose failed on shutdown", {
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
    })
    await this.chain
  }
}

export * as DshWebColdReloadModule from "./web-cold-reload.js"
