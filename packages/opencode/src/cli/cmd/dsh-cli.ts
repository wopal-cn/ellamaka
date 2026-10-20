/**
 * Pure argv-resolution helpers for the `ellamaka dsh` command surface,
 * mirroring the official `@deepseek-ai/dsh` launcher (bin.js) semantics:
 *
 * - `plugin`: `--profile` is the subcommand's own option; the remaining
 *   positional args are forwarded verbatim to the official installer
 *   (add/remove/install), while enable/disable/list stay ellamaka extensions.
 * - rejectParentOptions: the launcher flags (`--profile`, `--patch`,
 *   `--dump-config`, `--dump-default-config`) must not appear BEFORE the
 *   `plugin` subcommand.
 *
 * Kept dependency-free so the CLI glue stays trivially testable.
 */

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
  ellamaka dsh plugin --profile web add /path/to/bundle  install a local bundle (forwarded as file:<abs>)
  ellamaka dsh plugin --profile web list --json          list the profile's plugins as JSON
  ellamaka dsh plugin --profile web install              re-install every declared plugin dependency

Booting a profile is served by \`ellamaka serve\` — the official dsh boot mode
and the \`web\` alias are not part of the ellamaka surface.
`

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
