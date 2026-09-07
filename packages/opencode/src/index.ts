import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import { RunCommand } from "./cli/cmd/run"
import { GenerateCommand } from "./cli/cmd/generate"
import * as Log from "@wopal/ellamaka-core/util/log"
import { ConsoleCommand } from "./cli/cmd/account"
import { ProvidersCommand } from "./cli/cmd/providers"
import { AgentCommand } from "./cli/cmd/agent"
import { UpgradeCommand } from "./cli/cmd/upgrade"
import { UninstallCommand } from "./cli/cmd/uninstall"
import { ModelsCommand } from "./cli/cmd/models"
import { UI } from "./cli/ui"
import { Installation } from "./installation"
import { InstallationVersion } from "@wopal/ellamaka-core/installation/version"
import { NamedError } from "@wopal/ellamaka-core/util/error"
import { FormatError } from "./cli/error"
import { ServeCommand } from "./cli/cmd/serve"
import { Filesystem } from "@/util/filesystem"
import { DebugCommand } from "./cli/cmd/debug"
import { StatsCommand } from "./cli/cmd/stats"
import { McpCommand } from "./cli/cmd/mcp"
import { GithubCommand } from "./cli/cmd/github"
import { ExportCommand } from "./cli/cmd/export"
import { ImportCommand } from "./cli/cmd/import"
import { AttachCommand } from "./cli/cmd/tui/attach"
import { TuiThreadCommand } from "./cli/cmd/tui/thread"
import { AcpCommand } from "./cli/cmd/acp"
import { EOL } from "os"
import path from "node:path"
import { WebCommand } from "./cli/cmd/web"
import { PrCommand } from "./cli/cmd/pr"
import { BINARY_NAME } from "@wopal/ellamaka-brand/branding"
import { SessionCommand } from "./cli/cmd/session"
import { DbCommand } from "./cli/cmd/db"
import { Global } from "@wopal/ellamaka-core/global"
import { detectWopalSpace } from "@wopal/ellamaka-brand/detect"
import { JsonMigration } from "@/storage/json-migration"
import { Database } from "@/storage/db"
import { errorMessage } from "./util/error"
import { PluginCommand } from "./cli/cmd/plug"
import { DshPluginCommand } from "./cli/cmd/dsh-plugin"
import { DshDumpConfigCommand, runDshDump } from "./cli/cmd/dsh-dump-config"
import { dshDumpResolve, dshRootFlagsBeforePlugin, DSH_HELP_EXAMPLES } from "./cli/cmd/dsh-cli"
import { Effect } from "effect"
import { Heap } from "./cli/heap"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { ensureProcessMetadata } from "@wopal/ellamaka-core/util/opencode-process"
import { isRecord } from "@/util/record"

const processMetadata = ensureProcessMetadata("main")

process.on("unhandledRejection", (e) => {
  Log.Default.error("rejection", {
    e: errorMessage(e),
  })
})

process.on("uncaughtException", (e) => {
  Log.Default.error("exception", {
    e: errorMessage(e),
  })
})

const args = hideBin(process.argv)

function show(out: string) {
  const text = out.trimStart()
  if (!text.startsWith(BINARY_NAME + " ")) {
    process.stderr.write(UI.logo() + EOL + EOL)
    process.stderr.write(text)
    return
  }
  process.stderr.write(out)
}

// Server commands host multiple instances per-request; their space config is
// resolved per-instance in config.ts (tryLoadWopalSpaceConfig). Setting a
// process-wide WOPAL_SPACE flag from launch cwd here would be wrong for them —
// one server can host both space and General instances at the same time.
const SERVER_COMMANDS = new Set(["serve", "web"])

const cli = yargs(args)
  .parserConfiguration({ "populate--": true })
  .scriptName(BINARY_NAME)
  .wrap(100)
  .help("help", "show help")
  .alias("help", "h")
  .version("version", "show version number", InstallationVersion)
  .alias("version", "v")
  .option("print-logs", {
    describe: "print logs to stderr",
    type: "boolean",
  })
  .option("log-level", {
    describe: "log level",
    type: "string",
    choices: ["DEBUG", "INFO", "WARN", "ERROR"],
  })
  .option("pure", {
    describe: "run without external plugins",
    type: "boolean",
  })
  .option("disable-wopalspace", {
    describe: "disable WopalSpace mode (use native opencode behavior)",
    type: "boolean",
  })
  .middleware(async (opts) => {
    // Always clear any inherited WOPAL_SPACE / WOPAL_SPACE_ROOT from user env
    delete process.env.WOPAL_SPACE
    delete process.env.WOPAL_SPACE_ROOT

    if (opts.pure) {
      process.env.OPENCODE_PURE = "1"
    }

    const command = typeof opts._?.[0] === "string" ? opts._[0] : ""
    const role: "serve" | "tui" = SERVER_COMMANDS.has(command) ? "serve" : "tui"
    const detection = detectWopalSpace(process.cwd())
    if (Installation.isLocal() && detection) {
      process.env.WOPAL_DEBUG_LOG_DIR = path.join(detection.root, ".wopal-space", "logs")
    }
    if (!opts.disableWopalspace && !SERVER_COMMANDS.has(command) && detection) {
      process.env.WOPAL_SPACE = "1"
      process.env.WOPAL_SPACE_ROOT = detection.root
    }
    if (opts.logLevel) {
      process.env.OPENCODE_LOG_LEVEL = opts.logLevel
    }

    await Log.init({
      print: process.argv.includes("--print-logs"),
      dev: Installation.isLocal(),
      devFile: "ellamaka-dev-tui.log",
      role,
      level: (() => {
        if (opts.logLevel) return opts.logLevel as Log.Level
        if (Installation.isLocal()) return "DEBUG"
        return "INFO"
      })(),
    })

    Heap.start()

    process.env.AGENT = "1"
    process.env.OPENCODE = "1"
    process.env.OPENCODE_PID = String(process.pid)

    Log.Default.info("opencode", {
      version: InstallationVersion,
      args: process.argv.slice(2),
      process_role: processMetadata.processRole,
      run_id: processMetadata.runID,
    })

    const marker = Database.getPath()
    if (marker !== ":memory:" && !(await Filesystem.exists(marker))) {
      const tty = process.stderr.isTTY
      process.stderr.write("Performing one time database migration, may take a few minutes..." + EOL)
      const width = 36
      const orange = "\x1b[38;5;214m"
      const muted = "\x1b[0;2m"
      const reset = "\x1b[0m"
      let last = -1
      if (tty) process.stderr.write("\x1b[?25l")
      try {
        await JsonMigration.run(drizzle({ client: Database.Client().$client }), {
          progress: (event) => {
            const percent = Math.floor((event.current / event.total) * 100)
            if (percent === last && event.current !== event.total) return
            last = percent
            if (tty) {
              const fill = Math.round((percent / 100) * width)
              const bar = `${"■".repeat(fill)}${"･".repeat(width - fill)}`
              process.stderr.write(
                `\r${orange}${bar} ${percent.toString().padStart(3)}%${reset} ${muted}${event.label.padEnd(12)} ${event.current}/${event.total}${reset}`,
              )
              if (event.current === event.total) process.stderr.write("\n")
            } else {
              process.stderr.write(`sqlite-migration:${percent}${EOL}`)
            }
          },
        })
      } finally {
        if (tty) process.stderr.write("\x1b[?25h")
        else {
          process.stderr.write(`sqlite-migration:done${EOL}`)
        }
      }
      process.stderr.write("Database migration complete." + EOL)
    }
  })
  .usage("")
  .completion("completion", "generate shell completion script")
  .command(AcpCommand)
  .command(McpCommand)
  .command(TuiThreadCommand)
  .command(AttachCommand)
  .command(RunCommand)
  .command(GenerateCommand)
  .command(DebugCommand)
  .command(ConsoleCommand)
  .command(ProvidersCommand)
  .command(AgentCommand)
  .command(UpgradeCommand)
  .command(UninstallCommand)
  .command(ServeCommand)
  .command(WebCommand)
  .command(ModelsCommand)
  .command(StatsCommand)
  .command(ExportCommand)
  .command(ImportCommand)
  .command(GithubCommand)
  .command(PrCommand)
  .command(SessionCommand)
  .command(PluginCommand)
  .command({
    command: "dsh [args...]",
    describe: "dsh profile tools — plugin management and config dumps (official dsh CLI shape)",
    builder: (y) =>
      y
        .positional("args", {
          type: "string",
          array: true,
          default: [] as string[],
          describe: "launch arguments after the dsh flags (boot mode is served by `ellamaka serve`)",
        })
        // The launcher flags the official dsh parser owns (official order);
        // yargs hoists parent options, so they parse in every position.
        .option("profile", {
          type: "string",
          describe: "the profile under $WOPAL_HOME/dsh/home/profiles to operate on",
        })
        .option("patch", {
          type: "string",
          nargs: 1,
          array: true,
          describe: "extra patch-list overlay applied after the profile layer (repeatable, argv order)",
        })
        .option("dump-config", {
          type: "boolean",
          describe: "print the composed profile tree and exit",
        })
        .option("dump-default-config", {
          type: "boolean",
          describe: "print the profile's bundle layers (no user layer) and exit",
        })
        .middleware(() => {
          // Official rejectParentOptions (bin.js): launcher flags must not
          // precede the `plugin` subcommand. yargs hoists parent options, so
          // the position check runs on the raw argv, not parsed values.
          if (dshRootFlagsBeforePlugin(args)) {
            throw new Error(
              "error: dsh plugin takes none of parent --profile, --patch, --dump-config, or --dump-default-config before the subcommand (official dsh semantics); use: `ellamaka dsh plugin --profile <name> add <package>`",
            )
          }
        })
        .command(DshPluginCommand)
        .command(DshDumpConfigCommand)
        .epilogue(DSH_HELP_EXAMPLES),
    handler: async (argv) => {
      // Official resolveBoot semantics (Plan 223 D-01/D-03): the root flags
      // resolve a config dump; boot mode (`--profile <name>` without a dump
      // flag) errors pointing at `ellamaka serve` (Out of Scope here).
      const invocation = dshDumpResolve(
        {
          profile: argv.profile as string | undefined,
          patch: argv.patch as string[] | undefined,
          "dump-config": argv["dump-config"] === true,
          "dump-default-config": argv["dump-default-config"] === true,
        },
        (argv.args ?? []) as string[],
      )
      await Effect.runPromise(
        runDshDump({
          profileName: invocation.profile,
          defaultOnly: invocation.defaultOnly,
          overlayPatches: invocation.patches,
        }),
      )
    },
  })
  .command(DbCommand)
  .fail((msg, err) => {
    if (
      msg?.startsWith("Unknown argument") ||
      msg?.startsWith("Not enough non-option arguments") ||
      msg?.startsWith("Invalid values:")
    ) {
      if (err) throw err
      cli.showHelp(show)
    }
    if (err) throw err
    process.exit(1)
  })
  .strict()

try {
  if (args.includes("-h") || args.includes("--help")) {
    await cli.parse(args, (err: Error | undefined, _argv: unknown, out: string) => {
      if (err) throw err
      if (!out) return
      show(out)
    })
  } else {
    await cli.parse()
  }
} catch (e) {
  let data: Record<string, any> = {}
  if (e instanceof Error) {
    Object.assign(data, {
      name: e.name,
      message: e.message,
      cause: e.cause?.toString(),
      stack: e.stack,
    })
  }

  if (e instanceof NamedError) {
    const obj = e.toObject()
    if (isRecord(obj.data)) {
      for (const [key, value] of Object.entries(obj.data)) {
        if (key === "name" || key === "stack" || key === "cause") continue
        data[key] = value
      }
    }
  }

  if (e instanceof ResolveMessage) {
    Object.assign(data, {
      name: e.name,
      message: e.message,
      code: e.code,
      specifier: e.specifier,
      referrer: e.referrer,
      position: e.position,
      importKind: e.importKind,
    })
  }
  Log.Default.error("fatal", data)
  const formatted = FormatError(e)
  if (formatted) UI.error(formatted)
  if (formatted === undefined) {
    UI.error("Unexpected error, check log file at " + Log.file() + " for more details" + EOL)
    process.stderr.write(errorMessage(e) + EOL)
  }
  process.exitCode = 1
} finally {
  // Some subprocesses don't react properly to SIGTERM and similar signals.
  // Most notably, some docker-container-based MCP servers don't handle such signals unless
  // run using `docker run --init`.
  // Explicitly exit to avoid any hanging subprocesses.
  process.exit()
}
