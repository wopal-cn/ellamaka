import { log } from "@clack/prompts"
import { Effect } from "effect"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { Global } from "@wopal/ellamaka-core/global"
import { resolveInstallCommand } from "@wopal/ellamaka-cordis/plugins/install-command"
import { migratePluginStore } from "@wopal/ellamaka-cordis/plugins/migrate-store"
import { disableRow, enableRow } from "@wopal/ellamaka-cordis/plugins/patch-layer"
import { parseProfiles } from "./dsh-plugin-profiles"
import { CliError, effectCmd, fail } from "../effect-cmd"

/**
 * `ellamaka dsh plugin` — a thin surface over the OFFICIAL dsh plugin CLI.
 *
 * Installing a plugin is DSH's job: the profile directory is DSH state, its
 * installer is pnpm (shipped by DSH's plugin manager), and it owns the
 * declaration, the lockfile, the rollback and the bundle reconcile. Ellamaka
 * used to keep a second, pacote-based installer in this directory; that
 * duplicated the owner and wrote registry-shaped versions for packages that
 * exist only on disk, which made every official install fail with a 404.
 *
 * So `add`, `remove` and `install` are forwarded verbatim to
 * `dsh plugin --profile <name> …` running inside the product closure
 * (`dsh official` child role), with DSH_HOME pointed at this installation's home. Only
 * the verbs that are NOT installations stay here: `list` reads the profile
 * manifest, `enable`/`disable` write the user patch layer.
 *
 * Local directory operands are normalized to `file:<abs>` before forwarding:
 * a bare path makes pnpm record `link:` (a symlink that receives none of the
 * plugin's own dependencies). `file:` copies the package and installs them.
 */

const RISK_NOTE =
  "Third-party dsh plugins run in the same process as Ellamaka with filesystem and shell access. Only install plugins you trust."

/**
 * pnpm is a HOST prerequisite, exactly as it is for the official dsh CLI:
 * the product does not bundle or install one. Reporting the gap here keeps
 * the failure actionable — the official installer would otherwise surface it
 * as a bare exit 127 after printing its own log path.
 */
const PNPM_MISSING =
  "dsh plugin needs pnpm on PATH (the official dsh installer runs it inside the profile); install pnpm and retry — Ellamaka does not bundle one."

/** True when `pnpm` can be spawned. */
function pnpmAvailable(): boolean {
  const probe = spawnSync("pnpm", ["--version"], { stdio: "ignore" })
  return probe.error === undefined
}

function dshHome(): string {
  return join(Global.Path.wopalHome, "dsh")
}

/** Map a forwarded failure to a user-visible CliError. */
function toCliError(error: unknown): CliError {
  return new CliError({ message: error instanceof Error ? error.message : String(error) })
}

/** The profile patch file path for one profile. */
function patchPathOf(home: string, profile: string): string {
  return join(home, "home", "profiles", profile, "cordis.patch.yml")
}

/** Read one profile manifest (dynamic import keeps the light shim lean). */
async function readManifestOf(home: string, profile: string) {
  const { readProfileManifest } = await import("@wopal/ellamaka-cordis/plugins")
  return readProfileManifest(join(home, "home", "profiles", profile))
}

/** A registry range is a version; a local source is not (read the package instead). */
export function declaredVersion(spec: string | undefined): string | undefined {
  if (spec === undefined) return undefined
  return spec.startsWith("file:") || spec.startsWith("link:") ? undefined : spec
}

/** The version recorded inside an installed package directory. */
function installedVersion(home: string, profile: string, name: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(join(home, "home", "profiles", profile, "node_modules", ...name.split("/"), "package.json"), "utf8"),
    )
    if (typeof parsed !== "object" || parsed === null) return undefined
    const version = (parsed as { version?: unknown }).version
    return typeof version === "string" ? version : undefined
  } catch {
    return undefined
  }
}

/** True for the operands pnpm treats as a local directory. */
function isPathOperand(operand: string): boolean {
  return (
    operand === "." ||
    operand === ".." ||
    operand.startsWith("./") ||
    operand.startsWith("../") ||
    operand.startsWith("/")
  )
}

/**
 * Give pnpm an explicit `file:` source for a local directory. A bare path is
 * recorded as `link:` (symlink only), which silently loses the plugin's own
 * dependencies; `file:` copies the package and resolves them.
 */
export function normalizeAddArgs(args: readonly string[]): string[] {
  if (args[0] !== "add") return [...args]
  const operand = args[1]
  if (operand === undefined || operand.startsWith("file:") || operand.startsWith("link:")) return [...args]
  if (!isPathOperand(operand)) return [...args]
  return ["add", `file:${resolve(operand)}`, ...args.slice(2)]
}

/**
 * Run `<launcher> dsh official plugin --profile <p> <args>` for one profile.
 *
 * The child is the SAME CLI (resolved through the shared install-command
 * decision table), because a compiled product cannot hand arbitrary JS to its
 * own executable; the `dsh official` child role then runs the closure's dsh
 * entry point in that child.
 */
function forwardToOfficial(home: string, profile: string, pluginArgs: readonly string[]): void {
  const command = resolveInstallCommand({
    argv: process.argv,
    execPath: process.execPath,
    isBun: process.versions.bun !== undefined,
    env: process.env,
  })
  if (command === undefined) {
    throw new Error("cannot resolve the ellamaka launcher for the official dsh installer")
  }
  if (!pnpmAvailable()) throw new Error(PNPM_MISSING)
  const child = spawnSync(
    command[0],
    [...command.slice(1), "dsh", "official", "--home", home, "plugin", "--profile", profile, ...pluginArgs],
    { stdio: "inherit", env: { ...process.env, ELLAMAKA_DSH_TOOLS: "0" } },
  )
  if (child.error) throw child.error
  if (child.status !== 0) {
    throw new Error(
      `dsh plugin ${pluginArgs[0] ?? "?"} failed for profile ${profile} (exit ${child.status ?? child.signal})`,
    )
  }
}

export const DshPluginCommand = effectCmd({
  command: "plugin [args...]",
  describe:
    "manage a profile's dsh plugins through the official dsh installer (dsh plugin --profile <name> add <package>)",
  instance: false,
  // Engine-free shim: profile files and a forwarded CLI, no AppLayer boot
  // (DESIGN-dsh-base.md — `ellamaka dsh` must not start the engine).
  light: true,
  builder: (yargs) =>
    yargs
      .positional("args", {
        type: "string",
        array: true,
        default: [] as string[],
        describe:
          "plugin arguments forwarded to the official dsh CLI: add|remove|install <args> (a local directory becomes file:<abs>); ellamaka extensions: enable|disable|list",
      })
      // Official position: the subcommand's own option (works before or after
      // the verb, yargs hoists it into the child parse).
      .option("profile", {
        type: "string",
        describe: 'profile name or comma-separated list, e.g. "web,tools" (default: web,ellamaka-tools)',
      })
      .option("json", {
        type: "boolean",
        default: false,
        describe: "machine-readable output (list only)",
      }),
  handler: Effect.fn("Cli.dshPlugin")(function* (args) {
    const rawArgs: string[] = Array.isArray(args.args) ? args.args.map((arg: unknown) => String(arg)) : []
    const home = dshHome()

    let profiles: string[]
    try {
      profiles = parseProfiles(typeof args.profile === "string" ? args.profile : undefined)
    } catch (error) {
      return yield* fail(error instanceof Error ? error.message : String(error))
    }

    const verb = rawArgs[0]
    if (verb === undefined) {
      return yield* fail(
        "error: plugin needs arguments to forward (e.g. `ellamaka dsh plugin --profile web add <package>`)",
      )
    }

    yield* Effect.tryPromise({
      try: () => migratePluginStore(home),
      catch: toCliError,
    })

    if (verb === "list") {
      const plugins = yield* Effect.tryPromise({
        try: async () => {
          const manifest = await readManifestOf(home, profiles[0] ?? "web")
          return manifest.bundles
            .filter((name) => !name.startsWith("@deepseek-ai/"))
            .map((name) => {
              const spec = manifest.dependencies[name]
              return {
                name,
                version: declaredVersion(spec) ?? installedVersion(home, profiles[0] ?? "web", name) ?? "unknown",
              }
            })
        },
        catch: toCliError,
      })
      if (args.json === true) {
        process.stdout.write(JSON.stringify({ plugins }) + "\n")
        return undefined
      }
      if (plugins.length === 0) {
        log.info("No dsh plugins installed.")
        return undefined
      }
      for (const entry of plugins) log.info(`${entry.name}@${entry.version}`)
      return undefined
    }

    if (verb === "enable" || verb === "disable") {
      const enabled = verb === "enable"
      const pkg = rawArgs[1]
      if (pkg === undefined) {
        return yield* fail(`error: plugin ${verb} requires a <package> argument`)
      }
      yield* Effect.tryPromise({
        try: async () => {
          let touched = false
          for (const profile of profiles) {
            // Only a package the profile's manifest declares can flip state;
            // the patch layer is the enable/disable surface, not the install
            // record.
            const manifest = await readManifestOf(home, profile)
            const installed = pkg in manifest.dependencies || manifest.bundles.includes(pkg)
            if (!installed) continue
            touched = true
            if (enabled) await enableRow(patchPathOf(home, profile), pkg)
            else await disableRow(patchPathOf(home, profile), pkg)
          }
          if (!touched) throw new Error(`dsh plugin: ${pkg} is not installed`)
        },
        catch: toCliError,
      })
      log.success(`${enabled ? "Enabled" : "Disabled"} ${pkg}`)
      log.info(`Enabled in: ${profiles.join(", ")}`)
      return undefined
    }

    const forwarded = normalizeAddArgs(rawArgs)
    if (forwarded[0] === "add" && forwarded[1] !== undefined && !forwarded[1].startsWith("file:")) {
      log.info(RISK_NOTE)
    }
    yield* Effect.try({
      try: () => {
        for (const profile of profiles) forwardToOfficial(home, profile, forwarded)
      },
      catch: toCliError,
    })
    log.info("A running ellamaka server hot-reloads the profile via composition-file watching.")
    return undefined
  }),
})
