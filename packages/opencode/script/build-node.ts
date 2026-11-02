#!/usr/bin/env bun

import { Script } from "@wopal/ellamaka-release/build-env"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

process.chdir(dir)

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

const result = await Bun.build({
  target: "node",
  entrypoints: ["./src/node.ts"],
  outdir: "./dist/node",
  format: "esm",
  sourcemap: "linked",
  external: ["jsonc-parser", "@lydell/node-pty"],
  define: {
    OPENCODE_MIGRATIONS: JSON.stringify(migrations),
    ELLAMAKA_MODELS_DEV: generated.modelsData,
    // Inline both channel and version so the sidecar matches the CLI build
    // (build.ts). Without OPENCODE_VERSION, InstallationVersion falls back to
    // the literal "local" at runtime; in non-local channels the plugin pin
    // then resolves to @wopal/ellamaka-plugin@local, which fails with "No
    // matching version found". build-node.ts is the sidecar build, consumed by
    // dev.sh and the desktop package step, so it must define the same
    // compile-time constants as the CLI build.
    OPENCODE_VERSION: `'${Script.version}'`,
    OPENCODE_CHANNEL: `'${Script.channel}'`,
  },
  files: {
    "opencode-web-ui.gen.ts": "",
  },
})

if (!result.success) {
  throw new Error("Node sidecar build failed")
}

// The Desktop sidecar runs in Electron's Node utility process, not Bun.
// A Bun-only protocol import can be introduced transitively even when the
// platform-specific `#db` / `#pty` conditions resolve correctly, so enforce
// the runtime boundary on the emitted artifact rather than trusting source
// imports alone.
const nodeBundle = await Bun.file(path.join(dir, "dist", "node", "node.js")).text()
if (/(?:from\s+|import\()\s*["']bun:/.test(nodeBundle)) {
  throw new Error("Node sidecar bundle contains an unsupported bun: module import")
}

console.log("Build complete")
