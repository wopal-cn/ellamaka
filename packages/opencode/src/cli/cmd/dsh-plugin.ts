import { log } from "@clack/prompts"
import { Effect } from "effect"
import { join } from "node:path"
import { Global } from "@wopal/ellamaka-core/global"
import {
  installPackage,
  NotInstalledError,
  removePackage,
  listInstalled,
} from "@wopal/ellamaka-cordis/plugins/installer"
import { migratePluginStore } from "@wopal/ellamaka-cordis/plugins/migrate-store"
import { disableRow, enableRow } from "@wopal/ellamaka-cordis/plugins/patch-layer"
import { assertNotGithubSource } from "@wopal/ellamaka-cordis/plugins/installer"
import { parseRegistrySpec } from "./dsh-plugin-profiles"
import { dshResolvePluginArgs, type DshResolvedPlugin } from "./dsh-cli"
import { CliError, effectCmd, fail } from "../effect-cmd"

/**
 * `ellamaka dsh plugin` — the official-order command surface (DESIGN-dsh-poc
 * §632, Plan 223 D-02): `dsh plugin --profile <name> <args...>` with the
 * remaining args forwarded VERBATIM to the ellamaka Bun installer (never pnpm).
 *
 * Official verbs: `add <pkg>` / `remove <pkg>` / `install` (full reinstall of
 * every declared dependency, official `pnpm install` end state). Ellamaka
 * extensions: `enable <pkg>` / `disable <pkg>` / `list [--json]`. Unknown
 * verbs error with guidance instead of being forwarded.
 *
 * Every subcommand is a pure disk operation writing the OFFICIAL end state:
 * the package entity lands in `<profile>/node_modules/`, the declaration in
 * the profile `package.json`, and enable/disable writes the user patch layer
 * (`cordis.patch.yml`, official patch.ts semantics). The running server
 * watches those composition files and hot-replays (D-02/D-03) — the CLI
 * never touches containers directly.
 *
 * Before any operation the legacy plugin store (if present) is migrated
 * once into the profile manifests (idempotent; the retired file is kept for
 * rollback).
 */

const RISK_NOTE =
  "Third-party dsh plugins run in the same process as Ellamaka with filesystem and shell access. Only install plugins you trust."

function dshHome(): string {
  return join(Global.Path.wopalHome, "dsh")
}

/** Map an installer/migration error to a user-visible CliError. */
function toCliError(error: unknown): CliError {
  if (error instanceof NotInstalledError) {
    return new CliError({ message: error.message })
  }
  return new CliError({ message: error instanceof Error ? error.message : String(error) })
}

/** One-time legacy-store migration hook (idempotent, runs before anything). */
async function ensureMigrated(home: string): Promise<void> {
  await migratePluginStore(home)
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

export const DshPluginCommand = effectCmd({
  command: "plugin [args...]",
  describe:
    "manage a profile's dsh plugins via the ellamaka installer (official order: dsh plugin --profile <name> add <package>)",
  instance: false,
  // Engine-free shim: pure profile-file operations, no AppLayer boot
  // (DESIGN-dsh-poc — `ellamaka dsh` must not start the engine).
  light: true,
  builder: (yargs) =>
    yargs
      .positional("args", {
        type: "string",
        array: true,
        default: [] as string[],
        describe: "verbatim plugin arguments: add|remove|install|enable|disable|list (+ <package>)",
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
    const rawArgs = (args.args ?? []) as string[]
    const profileSpec = args.profile as string | undefined
    const home = dshHome()

    // Verbatim-args resolution (official reject semantics: no args, unknown
    // verb, missing <package>; local path operands resolve via `local`).
    let invocation: DshResolvedPlugin
    try {
      invocation = dshResolvePluginArgs(profileSpec, rawArgs, { json: args.json === true })
    } catch (error) {
      return yield* fail(error instanceof Error ? error.message : String(error))
    }

    yield* Effect.tryPromise({
      try: () => ensureMigrated(home),
      catch: toCliError,
    })

    if (invocation.mode === "install") {
      // Official `install` verb end state: every declared dependency is
      // (re-)installed from the profile package.json; up-to-date entries are
      // a no-op (replace semantics keep the same content).
      let installed = 0
      for (const profile of invocation.profiles) {
        const count = yield* Effect.tryPromise({
          try: async () => {
            const manifest = await readManifestOf(home, profile)
            const entries = Object.entries(manifest.dependencies)
            for (const [name, range] of entries) {
              await installPackage({ kind: "registry", name, version: range }, { home, profiles: [profile] })
            }
            return entries.length
          },
          catch: toCliError,
        })
        installed += count
      }
      log.success(`Install complete: ${installed} package(s) across ${invocation.profiles.length} profile(s)`)
      log.info("A running ellamaka server hot-mounts changes via composition-file watching.")
      return
    }

    const { action, pkg } = invocation

    if (action === "add") {
      const profiles = invocation.profiles
      if (invocation.local) {
        // Official pnpm path-spec semantics: the operand IS the directory.
        const result = yield* Effect.tryPromise({
          try: () => installPackage({ kind: "dir", path: pkg! }, { home, profiles }),
          catch: toCliError,
        })
        log.success(`Installed ${result.name}@${result.version} (${result.source})`)
        log.info(`Enabled in: ${profiles.join(", ")}`)
        if (result.warning) log.warn(result.warning)
        log.info("A running ellamaka server hot-mounts it via composition-file watching; otherwise it mounts at next boot.")
        return
      }
      // Phase-1 transport policy: github sources get a clear error with the
      // npm alternative before any network activity (D-07).
      yield* Effect.try({
        try: () => {
          const spec = parseRegistrySpec(pkg!)
          assertNotGithubSource(spec.kind === "registry" ? (spec.version ?? spec.name) : spec.name)
          return RISK_NOTE
        },
        catch: toCliError,
      })
      const result = yield* Effect.tryPromise({
        try: () => installPackage(parseRegistrySpec(pkg!), { home, profiles }),
        catch: toCliError,
      })
      log.success(`Installed ${result.name}@${result.version} (${result.source})`)
      log.info(`Enabled in: ${profiles.join(", ")}`)
      if (result.warning) log.warn(result.warning)
      log.info("A running ellamaka server hot-mounts it via composition-file watching; otherwise it mounts at next boot.")
      return
    }

    if (action === "remove") {
      yield* Effect.tryPromise({
        try: () => removePackage(pkg!, { home }),
        catch: toCliError,
      })
      log.success(`Removed ${pkg}`)
      log.info("A running ellamaka server unmounts it via composition-file watching.")
      return
    }

    if (action === "enable" || action === "disable") {
      const enabled = action === "enable"
      // Both verbs target the requested profiles (alias-expanded); omitted
      // --profile already falls back to both built-ins via parseProfiles.
      const targets = invocation.profiles
      yield* Effect.tryPromise({
        try: async () => {
          let touched = false
          for (const profile of targets) {
            // Only a package the profile's manifest declares can flip state;
            // the patch layer is the enable/disable surface, not the install
            // record.
            const patchPath = patchPathOf(home, profile)
            const manifest = await readManifestOf(home, profile)
            const installed = pkg! in manifest.dependencies || manifest.bundles.includes(pkg!)
            if (!installed) continue
            touched = true
            if (enabled) await enableRow(patchPath, pkg!)
            else await disableRow(patchPath, pkg!)
          }
          if (!touched) throw new NotInstalledError(pkg!)
        },
        catch: toCliError,
      })
      log.success(`${enabled ? "Enabled" : "Disabled"} ${pkg}`)
      log.info(`Enabled in: ${targets.join(", ")}`)
      return
    }

    if (action === "list") {
      const plugins = yield* Effect.try({
        try: () => listInstalled(home, invocation.profiles[0] ?? "web"),
        catch: toCliError,
      })
      if (invocation.json === true) {
        process.stdout.write(JSON.stringify({ plugins }) + "\n")
        return
      }
      if (plugins.length === 0) {
        log.info("No dsh plugins installed.")
        return
      }
      for (const entry of plugins) {
        log.info(`${entry.name}@${entry.version}`)
      }
      return
    }

    return yield* fail(`unknown dsh plugin action: ${action} (expected add|remove|install|enable|disable|list)`)
  }),
})
