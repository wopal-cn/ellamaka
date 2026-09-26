import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import { TuiThreadCommand } from "./cli/cmd/tui/thread"
import { Installation } from "@/installation"
import { InstallationVersion } from "@wopal/ellamaka-core/installation/version"
import { Log } from "./node"
import { BINARY_NAME } from "@wopal/ellamaka-brand/branding"
import { resolveLogLevel } from "./cli/log-level"

const cli = yargs(hideBin(process.argv))
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
  .middleware(async (opts) => {
    // Resolve the level through the unified composition only after yargs has
    // parsed the explicit `--log-level`, so this entry cannot bypass the
    // precedence chain (`--log-level` > env > config > INFO) with a stale
    // default. The result is written back for the process tree.
    const requested = opts.logLevel
    const requestedLevel: Log.Level | undefined =
      requested === "DEBUG" || requested === "INFO" || requested === "WARN" || requested === "ERROR"
        ? requested
        : undefined
    const level = resolveLogLevel({ requested: requestedLevel })
    process.env.ELLAMAKA_LOG_LEVEL = level
    await Log.init({
      print: process.argv.includes("--print-logs"),
      dev: Installation.isLocal(),
      role: "tui",
      level,
    })
  })
  .command(TuiThreadCommand)
  .parse()
