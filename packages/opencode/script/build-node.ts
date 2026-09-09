#!/usr/bin/env bun

import { Script } from "@wopal/ellamaka-release/build-env"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

process.chdir(dir)

// Read the effective minimum wopal-cli version from .ci/versions.json.
// Build scripts (scripts/build.sh / dev.sh) normally export
// MIN_WOPAL_CLI_VERSION already; this is the fallback for direct invocations.
function readMinWopalCliVersion(): string {
  try {
    const versions = JSON.parse(fs.readFileSync(path.resolve(dir, "../../.ci/versions.json"), "utf8"))
    if (typeof versions.minWopalCli === "string" && versions.minWopalCli) return versions.minWopalCli
  } catch {}
  return "0.3.13"
}

const generated = await import("./generate.ts")

// Load migrations from migration directories
const migrationDirs = (
  await fs.promises.readdir(path.join(dir, "migration"), {
    withFileTypes: true,
  })
)
  .filter((entry) => entry.isDirectory() && /^\d{4}\d{2}\d{2}\d{2}\d{2}\d{2}/.test(entry.name))
  .map((entry) => entry.name)
  .sort()

const migrations = await Promise.all(
  migrationDirs.map(async (name) => {
    const file = path.join(dir, "migration", name, "migration.sql")
    const sql = await Bun.file(file).text()
    const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(name)
    const timestamp = match
      ? Date.UTC(
          Number(match[1]),
          Number(match[2]) - 1,
          Number(match[3]),
          Number(match[4]),
          Number(match[5]),
          Number(match[6]),
        )
      : 0
    return { sql, timestamp, name }
  }),
)
console.log(`Loaded ${migrations.length} migrations`)

await Bun.build({
  target: "node",
  entrypoints: ["./src/node.ts"],
  outdir: "./dist/node",
  format: "esm",
  sourcemap: "linked",
  external: ["jsonc-parser", "@lydell/node-pty"],
  define: {
    OPENCODE_MIGRATIONS: JSON.stringify(migrations),
    OPENCODE_MODELS_DEV: generated.modelsData,
    // Inline both channel and version so the sidecar matches the CLI build
    // (build.ts). Without OPENCODE_VERSION, InstallationVersion falls back to
    // the literal "local" at runtime; in non-local channels that string is
    // then passed to npm as @opencode-ai/plugin@local, which fails with "No
    // matching version found". build-node.ts is the sidecar build, consumed by
    // dev.sh and the desktop package step, so it must define the same
    // compile-time constants as the CLI build.
    OPENCODE_VERSION: `'${Script.version}'`,
    OPENCODE_CHANNEL: `'${Script.channel}'`,
    // Inline the effective minimum wopal-cli version so the sidecar enforces
    // the same protocol floor as the CLI build. The value comes from
    // MIN_WOPAL_CLI_VERSION (exported by scripts/build.sh / dev.sh via
    // scripts/lib/version.sh resolve_min_wopal_cli_version); fall back to
    // .ci/versions.json when unset.
    "process.env.MIN_WOPAL_CLI_VERSION": `'${process.env.MIN_WOPAL_CLI_VERSION || readMinWopalCliVersion()}'`,
  },
  files: {
    "opencode-web-ui.gen.ts": "",
  },
})

console.log("Build complete")
