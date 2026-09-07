/**
 * Pure argv-resolution helpers for the `ellamaka dsh` command surface,
 * mirroring the official `@deepseek-ai/dsh` launcher (bin.js) semantics:
 *
 * - `plugin`: `--profile` is the subcommand's own option; the remaining
 *   positional args are forwarded verbatim (add/remove/install official
 *   verbs; enable/disable/list ellamaka extensions).
 * - rejectParentOptions: the launcher flags (`--profile`, `--patch`,
 *   `--dump-config`, `--dump-default-config`) must not appear BEFORE the
 *   `plugin` subcommand.
 *
 * Commander-semantics equivalence note: the official parser's
 * `allowUnknownOption` + `passThroughOptions` (verbatim forwarding without
 * declaring every flag) is implemented here as plain verbatim positionals
 * resolved by `dshResolvePluginArgs` under the default (non-strict) child
 * parse, with explicit unknown-verb/missing-operand errors — the behaviour
 * is pinned by the dsh-plugin-command definition tests.
 *
 * Kept dependency-free so the CLI glue stays trivially testable (same pattern
 * as dsh-plugin-profiles.ts).
 */

import { parseProfiles } from "./dsh-plugin-profiles"

/** The launcher flags the official dsh parser owns (order = help-text order). */
export const DSH_PARENT_FLAGS = ["--profile", "--patch", "--dump-config", "--dump-default-config"] as const

/**
 * Help examples in the official bin.js HELP_EXAMPLES shape, adapted to the
 * ellamaka surface: boot examples are replaced by the `ellamaka serve` note
 * and there is no `dsh web` command (Plan 223 D-01, Out of Scope).
 */
export const DSH_HELP_EXAMPLES = `
Examples:
  ellamaka dsh --dump-config --profile web               print the composed profile patch tree and exit
  ellamaka dsh --dump-default-config --profile web       print the bundle layers only (no user layer) and exit
  ellamaka dsh --dump-config --profile web --patch ./extra.yml
                                                         apply extra overlays after the profile layer (repeatable)
  ellamaka dsh plugin --profile web add <package>        install a plugin into the web profile (official order)
  ellamaka dsh plugin --profile web list --json          list the profile's plugins as JSON
  ellamaka dsh plugin --profile web install              re-install every declared plugin dependency

Booting a profile is served by \`ellamaka serve\` — the official dsh boot mode
and the \`web\` alias are not part of the ellamaka surface.
`

/** The plugin verbs: official verbatim forward + ellamaka extensions. */
export const DSH_PLUGIN_OFFICIAL_VERBS = ["add", "remove", "install"] as const
export const DSH_PLUGIN_EXTENSION_VERBS = ["enable", "disable", "list"] as const

export interface DshPluginInvocation {
  mode: "plugin"
  profiles: string[]
  action: string
  pkg?: string
  /** The add operand is a local directory spec (official pnpm path semantics). */
  local?: boolean
  json?: boolean
}

export interface DshInstallInvocation {
  mode: "install"
  profiles: string[]
}

/** One resolved `dsh plugin` invocation (official shape + ellamaka superset). */
export type DshResolvedPlugin = DshPluginInvocation | DshInstallInvocation

/** The verbatim verbs the ellamaka installer implements. */
const KNOWN_VERBS: readonly string[] = [...DSH_PLUGIN_OFFICIAL_VERBS, ...DSH_PLUGIN_EXTENSION_VERBS]

/**
 * Resolve `dsh plugin` verbatim args into one invocation, official order
 * (`plugin --profile web add <pkg>`); `--profile` supports single (official)
 * and comma-separated multi (ellamaka extension), omitted falls back to the
 * built-in default (A2 compat: `web,ellamaka-tools`).
 *
 * Throws with user-visible guidance for the official error cases: no args
 * (usage hint), unknown verbs (not forwarded), missing <pkg>.
 */
export function dshResolvePluginArgs(
  profile: string | undefined,
  args: readonly string[],
  opts: { json?: boolean } = {},
): DshResolvedPlugin {
  const verb = args[0]
  if (verb === undefined) {
    throw new Error("error: plugin needs arguments to forward (e.g. add <package>); in ellamaka: `ellamaka dsh plugin --profile <name> add <package>`")
  }
  if (!KNOWN_VERBS.includes(verb)) {
    throw new Error(`error: unknown plugin verb "${verb}" (official pnpm verbs other than add/remove/install are not forwarded; ellamaka supports ${KNOWN_VERBS.join("|")})`)
  }
  const profiles = parseProfiles(profile)
  const pkg = args[1]

  if (verb === "install") {
    return { mode: "install", profiles }
  }
  if (verb === "list") {
    return { mode: "plugin", profiles, action: "list", json: opts.json === true }
  }
  // add/remove/enable/disable all require the package operand.
  if (pkg === undefined) {
    throw new Error(`error: plugin ${verb} requires a <package> argument (e.g. \`ellamaka dsh plugin --profile <name> ${verb} <package>\`)`)
  }
  // Official pnpm path-spec semantics: a local directory operand installs
  // from the filesystem (add only — the other verbs operate on installed
  // names, a path there is a user error).
  if (verb === "add") {
    return { mode: "plugin", profiles, action: "add", pkg, local: isPathSpec(pkg) }
  }
  if (isPathSpec(pkg)) {
    throw new Error(`error: plugin ${verb} takes an installed package name, not a path ("${pkg}"; local directories are only valid for add)`)
  }
  return { mode: "plugin", profiles, action: verb, pkg, local: false }
}

/**
 * Official pnpm filesystem-spec detection: `add .`, `add ../dir`,
 * `add ./dir`, and absolute paths install from a local directory. Registry
 * names never start with these (`.`/`/`-prefixed names are impossible).
 */
function isPathSpec(pkg: string): boolean {
  return pkg === "." || pkg === ".." || pkg.startsWith("./") || pkg.startsWith("../") || pkg.startsWith("/")
}

/**
 * Official rejectParentOptions: detect launcher flags appearing BEFORE the
 * `plugin` subcommand token in argv order (yargs hoists parent options, so
 * position must be checked on raw argv, not on parsed values).
 *
 * `argv` is the dsh-level argv slice starting at `dsh`. Returns true when a
 * parent flag precedes the `plugin` token.
 */
export function dshRootFlagsBeforePlugin(argv: readonly string[]): boolean {
  const pluginIndex = argv.indexOf("plugin")
  if (pluginIndex === -1) return false
  return argv.slice(0, pluginIndex).some((token) => (DSH_PARENT_FLAGS as readonly string[]).includes(token))
}

/** The dsh launcher flags, as parsed by the `dsh` parent command. */
export interface DshDumpFlags {
  profile?: string
  patch?: string[]
  "dump-config"?: boolean
  "dump-default-config"?: boolean
}

/** One resolved `dsh --dump-config` / `--dump-default-config` invocation. */
export interface DshDumpInvocation {
  mode: "dump-config"
  profile: string
  defaultOnly: boolean
  /** `--patch` overlay paths, argv order. */
  patches: string[]
}

/** Whether the root dump flags were requested (official resolveBoot gate). */
export function dshDumpRequested(flags: DshDumpFlags): boolean {
  return flags["dump-config"] === true || flags["dump-default-config"] === true
}

/**
 * Resolve the `dsh` root invocation from the launcher flags, mirroring the
 * official bin.js `resolveBoot` errors and Plan 223 D-01/D-03:
 *
 * - `--profile <name>` is required; empty errors ("needs a name")
 * - `--patch` needs a path (empty value)
 * - boot mode (`--profile <name>` + args, no dump flag) errors and points at
 *   `ellamaka serve` (the boot surface is owned by serve, Out of Scope)
 * - `--dump-config` and `--dump-default-config` are mutually exclusive
 * - config dumps take no app arguments
 * - `--dump-default-config` rejects `--patch`
 */
export function dshDumpResolve(flags: DshDumpFlags, appArgs: readonly string[]): DshDumpInvocation {
  const profile = flags.profile
  if (profile === undefined) {
    throw new Error("error: --profile <name> is required (boot mode is served by `ellamaka serve`)")
  }
  if (profile === "") {
    throw new Error("error: --profile needs a name")
  }
  const patches = flags.patch ?? []
  if (patches.includes("")) {
    throw new Error("error: --patch needs a path")
  }
  if (!dshDumpRequested(flags)) {
    throw new Error(
      `error: booting profile "${profile}" is served by \`ellamaka serve\` — the ellamaka dsh surface only manages plugins and config dumps (official dsh boot mode is not implemented)`,
    )
  }
  if (flags["dump-config"] === true && flags["dump-default-config"] === true) {
    throw new Error("error: --dump-config and --dump-default-config are mutually exclusive")
  }
  if (appArgs.length > 0) {
    throw new Error(`error: config dumps take no app arguments, got ${appArgs.map((a) => JSON.stringify(a)).join(" ")}`)
  }
  const defaultOnly = flags["dump-default-config"] === true
  if (defaultOnly && patches.length > 0) {
    throw new Error("error: --dump-default-config prints the bundle layers and takes no --patch")
  }
  return { mode: "dump-config", profile, defaultOnly, patches }
}
