import yargs from "yargs"
import { TuiThreadCommand } from "./cli/cmd/tui/thread"
import { Installation } from "@/installation"
import { InstallationVersion } from "@wopal/ellamaka-core/installation/version"
import { hideBin } from "yargs/helpers"
import { Log } from "./node"
import type { Level } from "@wopal/ellamaka-core/util/log"
import { BINARY_NAME } from "@wopal/ellamaka-brand/branding"

Log.init({
  print: process.argv.includes("--print-logs"),
  dev: Installation.isLocal(),
  devFile: "ellamaka-dev-tui.log",
  role: "tui",
  level: (process.env.OPENCODE_LOG_LEVEL as Level) ?? (Installation.isLocal() ? "DEBUG" : "INFO"),
})

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
  .command(TuiThreadCommand)
  .parse()
