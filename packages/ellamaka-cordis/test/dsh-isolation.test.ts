import { describe, expect, test } from "bun:test"
import { mkdtempSync, existsSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { Context } from "@deepseek-ai/cordis"
import { mountDshWeb, mountDshTools } from "../src/dsh-web"

/**
 * dsh runtime isolation (DESIGN-dsh-poc §3.4): every dsh engine runtime byte
 * (settings/sessions/storages/credentials) lands under `$WOPAL_HOME/dsh/home`,
 * NOT `~/.dsh`. Purely via config injection — `process.env.DSH_HOME` is never
 * set by the integration code itself (the host sets it for B-class env reads
 * at process launch).
 */

describe("dsh runtime isolation", () => {
  test("never sets process.env.DSH_HOME", async () => {
    // The mount itself must not set the env; an ambient value inherited from
    // the surrounding process (e.g. running inside a dsh session) is not the
    // mount's doing, so isolate it for the duration of the assertion. The
    // mount stays inside try: a throw must still restore the env and release
    // the context.
    const prevDshHome = process.env.DSH_HOME
    delete process.env.DSH_HOME
    const home = mkdtempSync(join(tmpdir(), "dsh-isolate-env-"))
    const ctx = new Context()
    let host: Awaited<ReturnType<typeof mountDshWeb>> | undefined
    try {
      host = await mountDshWeb(ctx, { home, port: 4097, disableCodeRuntime: true })
      expect(process.env.DSH_HOME).toBeUndefined()
    } finally {
      if (prevDshHome !== undefined) process.env.DSH_HOME = prevDshHome
      await host?.dispose()
      await ctx.fiber.dispose()
    }
  }, 30_000)

  test("settings runtime file lands in home/ not ~/.dsh", async () => {
    const home = mkdtempSync(join(tmpdir(), "dsh-isolate-settings-"))
    const ctx = new Context()
    const host = await mountDshWeb(ctx, { home, port: 4097, disableCodeRuntime: true })
    try {
      // The settings service is mounted; a namespaced update persists through
      // the file provider to `<home>/settings.yaml`.
      const settings = ctx.get("settings") as
        | { update(ns: string, patch: unknown): Promise<unknown> }
        | undefined
      expect(settings).toBeDefined()

      await settings!.update("agent-default-model", { provider: "test-provider" })

      // Wait a tick for the async persist to flush to disk.
      await new Promise((r) => setTimeout(r, 300))

      const homeSettings = join(home, "home", "settings.yaml")
      expect(existsSync(homeSettings)).toBe(true)

      // The written document lives under the mount's home/ dir — never the
      // user's default ~/.dsh home. The home dir for this mount is a temp dir,
      // so its settings cannot be under the user's real home.
      expect(homeSettings.startsWith(join(homedir(), ".dsh"))).toBe(false)
      expect(homeSettings.startsWith(home)).toBe(true)
    } finally {
      await host.dispose()
      await ctx.fiber.dispose()
    }
  }, 30_000)

  test("tools profile still overrides ctx dshHomePath to home/", async () => {
    const home = mkdtempSync(join(tmpdir(), "dsh-isolate-tools-"))
    const ctx = new Context()
    const host = await mountDshTools(ctx, { home, port: 0 })
    try {
      // The tools profile disables the agent-loop rows (incl. `settings`), so
      // there is no settings persistence to redirect; the A-type ctx override
      // still applies for any `!!js dshHomePath(...)` the tool bundle uses.
      const injected = ctx.get("dshHomePath") as ((...s: string[]) => string) | undefined
      expect(injected).toBeDefined()
      expect(injected!("sessions")).toBe(join(home, "home", "sessions"))
    } finally {
      await host.dispose()
      await ctx.fiber.dispose()
    }
  }, 30_000)

  test("ctx dshHomePath override resolves storages/sessions under home/", async () => {
    const home = mkdtempSync(join(tmpdir(), "dsh-isolate-dshhomepath-"))
    const ctx = new Context()
    const host = await mountDshWeb(ctx, { home, port: 4097, disableCodeRuntime: true })
    try {
      // The ctx-injected dshHomePath is what `!!js dshHomePath('sessions')`
      // expressions evaluate. Reading it directly proves the override is in
      // place and rooted at home/.
      const injected = ctx.get("dshHomePath") as ((...s: string[]) => string) | undefined
      expect(injected).toBeDefined()
      expect(injected!("sessions")).toBe(join(home, "home", "sessions"))
      expect(injected!("storages")).toBe(join(home, "home", "storages"))
    } finally {
      await host.dispose()
      await ctx.fiber.dispose()
    }
  }, 30_000)

  test("omitted home falls back to $WOPAL_HOME/dsh for home and profile paths (W-01)", async () => {
    // When `home` is omitted, mountProfile must use the standard $WOPAL_HOME/dsh
    // consistently across the home dir AND the profile pathing (healProfilesModule
    // fallback / loadProfile), never ~/.dsh.
    const prevWopalHome = process.env.WOPAL_HOME
    const wopalHome = mkdtempSync(join(tmpdir(), "dsh-iso-omitted-home-"))
    process.env.WOPAL_HOME = wopalHome
    const ctx = new Context()
    let host: { dispose(): Promise<void> }
    try {
      host = await mountDshWeb(ctx, { port: 4097, disableCodeRuntime: true })
      const injected = ctx.get("dshHomePath") as ((...s: string[]) => string) | undefined
      expect(injected).toBeDefined()
      expect(injected!("sessions")).toBe(join(wopalHome, "dsh", "home", "sessions"))

      // Profiles were seeded under the resolved home, not ~/.dsh.
      expect(existsSync(join(wopalHome, "dsh", "home", "profiles", "web", "package.json"))).toBe(true)
    } finally {
      if (prevWopalHome === undefined) delete process.env.WOPAL_HOME
      else process.env.WOPAL_HOME = prevWopalHome
      await host.dispose()
      await ctx.fiber.dispose()
    }
  }, 30_000)

  test("llm-deepseek is disabled so its ~/.dsh writes cannot happen (B-02)", async () => {
    // The llm-deepseek plugin resolves the anonymous-user-id and the upload
    // index via `resolveDshHome()` with no config seam, falling back to
    // `~/.dsh` when DSH_HOME is unset. Since we must not set DSH_HOME, the
    // adapter is disabled — so no DeepSeek model call or image upload can
    // write to the user's default ~/.dsh.
    const home = mkdtempSync(join(tmpdir(), "dsh-isolate-llm-deepseek-"))
    const ctx = new Context()
    const host = await mountDshWeb(ctx, { home, port: 4097, disableCodeRuntime: true })
    try {
      // Deterministic proof: with llm-deepseek disabled, its provider route is
      // not registered, so neither the anonymous-user-id resolution (runs on
      // every DeepSeek model call) nor the upload-index store (created on image
      // upload) can execute.
      const llm = ctx.get("llm") as { listProviders(): { id: string }[] } | undefined
      expect(llm).toBeDefined()
      const providerIds = llm!.listProviders().map((p) => p.id)
      expect(providerIds).not.toContain("deepseek-official")
    } finally {
      await host.dispose()
      await ctx.fiber.dispose()
    }
  }, 30_000)

  test("session-telemetry-otel is disabled even with DSH_TELEMETRY_MODE=FULL (B-02)", async () => {
    // The telemetry plugin calls getOrCreateAnonymousUserId() with no home seam
    // when enabled, writing ~/.dsh/.anonymous-user-id. It can be turned on by an
    // inherited DSH_TELEMETRY_MODE env, so it must be disabled regardless.
    const prevMode = process.env.DSH_TELEMETRY_MODE
    process.env.DSH_TELEMETRY_MODE = "FULL"
    const home = mkdtempSync(join(tmpdir(), "dsh-isolate-telemetry-"))
    const ctx = new Context()
    const host = await mountDshWeb(ctx, { home, port: 4097, disableCodeRuntime: true })
    try {
      // With session-telemetry-otel disabled, the `telemetry` service is absent.
      expect(ctx.get("telemetry")).toBeUndefined()
    } finally {
      if (prevMode === undefined) delete process.env.DSH_TELEMETRY_MODE
      else process.env.DSH_TELEMETRY_MODE = prevMode
      await host.dispose()
      await ctx.fiber.dispose()
    }
  }, 30_000)
})
