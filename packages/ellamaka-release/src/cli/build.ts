#!/usr/bin/env bun

import { $ } from "bun"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"
import { BINARY_NAME, CHANNEL_RELEASE } from "@wopal/ellamaka-brand/branding"
import { buildReleaseIdentityForBuild } from "../build-identity"
import { filterTargets, type BuildTarget } from "../build-targets"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "../../../opencode")
const distDir = path.resolve(__dirname, "../../../../dist")

process.chdir(dir)

const generated = await import("../../../opencode/script/generate.ts")

import { Script } from "../build-env"
import pkg from "../../../opencode/package.json"

// Release builds always use the release channel (latest). Development builds
// respect the channel passed via OPENCODE_CHANNEL (build.sh cli --channel
// main|prod; dev.sh sets local), so the binary's channel and its database
// name agree.
const channel = Script.release ? CHANNEL_RELEASE : Script.channel

// ── DSH runtime manifest freshness gate ─────────────────────────────
// The bundled CLI carries the DSH runtime manifest through the static JSON
// import in `@wopal/ellamaka-cordis/runtime` (embed-manifest.ts), which Bun
// inlines at bundle time. So the generated manifest must exist and match the
// source before any bundling below.
//
// Release builds only ever verify (`--check`, read-only, exit != 0 on drift)
// — they must not regenerate a manifest that is committed to the repo.
// Development builds generate when the manifest is missing or dirty, with a
// warning, so a local build never ships a stale closure definition.
const dshManifestGenerator = path.resolve(
  __dirname,
  "../../../ellamaka-cordis/script/generate-dsh-runtime-manifest.ts",
)
const dshManifestPath = path.resolve(
  __dirname,
  "../../../ellamaka-cordis/generated/dsh-runtime-manifest.json",
)
async function ensureDshRuntimeManifest() {
  if (Script.release) {
    console.log("[build] verifying DSH runtime manifest (--check)")
    await $`bun ${dshManifestGenerator} --check`
    return
  }
  const generate = async () => {
    console.log("[build] generating DSH runtime manifest")
    await $`bun ${dshManifestGenerator}`
  }
  if (!fs.existsSync(dshManifestPath)) {
    await generate()
    return
  }
  // Dev mode: generate when dirty (no longer matching the source) and warn.
  try {
    await $`bun ${dshManifestGenerator} --check`
  } catch {
    console.warn("[build] DSH runtime manifest is out of date — regenerating for dev build")
    await generate()
  }
}
await ensureDshRuntimeManifest()

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

// --platform: "mac" | "linux" | "win" | "mac,linux" etc.
const platformIndex = process.argv.indexOf("--platform")
const platformArg = platformIndex !== -1 ? process.argv[platformIndex + 1] : null

// --arch: "arm64" | "x64" | "arm64,x64" etc.
const archIndex = process.argv.indexOf("--arch")
const archArg = archIndex !== -1 ? process.argv[archIndex + 1] : null

const singleFlag = process.argv.includes("--single")
const baselineFlag = process.argv.includes("--baseline")
const sourcemapsFlag = process.argv.includes("--sourcemaps")
const plugin = createSolidTransformPlugin()
const skipEmbedWebUi = process.argv.includes("--skip-embed-web-ui")
const webUiOptions = ["ellamaka-app", "none"] as const
type WebUiOption = (typeof webUiOptions)[number]
const webUiIndex = process.argv.indexOf("--web-ui")
const webUiArg = webUiIndex === -1 ? "ellamaka-app" : process.argv[webUiIndex + 1]

if (!webUiOptions.includes(webUiArg as WebUiOption)) {
  console.error(`Invalid --web-ui value: ${webUiArg ?? "<missing>"}`)
  console.error(`Expected one of: ${webUiOptions.join(", ")}`)
  process.exit(1)
}

if (skipEmbedWebUi && webUiIndex !== -1 && webUiArg !== "none") {
  console.error(`--skip-embed-web-ui cannot be combined with --web-ui ${webUiArg}`)
  console.error(`Use --web-ui none instead`)
  process.exit(1)
}

const webUi = (skipEmbedWebUi ? "none" : webUiArg) as WebUiOption

const createEmbeddedWebUIBundle = async (webUi: Exclude<WebUiOption, "none">) => {
  console.log(`Building ${webUi} Web UI to embed in the binary`)
  const appDir = path.join(import.meta.dirname, "../../../", webUi)
  const dist = path.join(appDir, "dist")
  await $`bun run --cwd ${appDir} build`
  const files = (await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: dist })))
    .map((file) => file.replaceAll("\\", "/"))
    .filter((file) => !file.endsWith(".map"))
    .sort()
  const imports = files.map((file, i) => {
    const spec = path.relative(dir, path.join(dist, file)).replaceAll("\\", "/")
    return `import file_${i} from ${JSON.stringify(spec.startsWith(".") ? spec : `./${spec}`)} with { type: "file" };`
  })
  const entries = files.map((file, i) => `  ${JSON.stringify(file)}: file_${i},`)
  return [
    `// Import all files as file_$i with type: "file"`,
    ...imports,
    `// Export with original mappings`,
    `export default {`,
    ...entries,
    `}`,
  ].join("\n")
}

const embeddedFileMap = webUi === "none" ? null : await createEmbeddedWebUIBundle(webUi)

// Filter the target matrix. filterTargets fails fast on an empty result —
// building zero targets must never look like a successful build.
let targets: BuildTarget[]
try {
  targets = filterTargets({ platformArg, archArg, singleFlag, baselineFlag })
} catch (err) {
  console.error((err as Error).message)
  process.exit(1)
}

await $`rm -rf ${distDir}`

const binaries: Record<string, string> = {}
if (!singleFlag) {
  await $`bun install --os="*" --cpu="*" @opentui/core@${pkg.dependencies["@opentui/core"]}`
  await $`bun install --os="*" --cpu="*" @parcel/watcher@${pkg.dependencies["@parcel/watcher"]}`
}
for (const item of targets) {
  const name = [
    BINARY_NAME,
    // changing to win32 flags npm for some reason
    item.os === "win32" ? "windows" : item.os,
    item.arch,
    item.avx2 === false ? "baseline" : undefined,
    item.abi === undefined ? undefined : item.abi,
  ]
    .filter(Boolean)
    .join("-")
  console.log(`building ${name}`)
  await $`mkdir -p ${distDir}/${name}/bin`

  const localPath = path.resolve(dir, "node_modules/@opentui/core/parser.worker.js")
  const rootPath = path.resolve(dir, "../../node_modules/@opentui/core/parser.worker.js")
  const parserWorker = fs.realpathSync(fs.existsSync(localPath) ? localPath : rootPath)
  const workerPath = "./src/cli/cmd/tui/worker.ts"

  // Use platform-specific bunfs root path based on target OS
  const bunfsRoot = item.os === "win32" ? "B:/~BUN/root/" : "/$bunfs/root/"
  const workerRelativePath = path.relative(dir, parserWorker).replaceAll("\\", "/")

  await Bun.build({
    conditions: ["browser"],
    tsconfig: "./tsconfig.json",
    plugins: [plugin],
    external: ["node-gyp"],
    format: "esm",
    minify: true,
    sourcemap: sourcemapsFlag ? "linked" : "none",
    splitting: true,
    compile: {
      autoloadBunfig: false,
      autoloadDotenv: false,
      autoloadTsconfig: true,
      autoloadPackageJson: true,
      target: name.replace(BINARY_NAME, "bun") as any,
      outfile: `${distDir}/${name}/bin/${BINARY_NAME}`,
      execArgv: [`--user-agent=${BINARY_NAME}/${Script.version}`, "--use-system-ca", "--"],
      windows: {},
    },
    files: embeddedFileMap ? { "opencode-web-ui.gen.ts": embeddedFileMap } : {},
    entrypoints: ["./src/index.ts", parserWorker, workerPath, ...(embeddedFileMap ? ["opencode-web-ui.gen.ts"] : [])],
    define: {
      OPENCODE_VERSION: `'${Script.version}'`,
      OPENCODE_MIGRATIONS: JSON.stringify(migrations),
      OPENCODE_MODELS_DEV: generated.modelsData,
      OTUI_TREE_SITTER_WORKER_PATH: bunfsRoot + workerRelativePath,
      OPENCODE_WORKER_PATH: workerPath,
      OPENCODE_CHANNEL: `'${channel}'`,
      OPENCODE_LIBC: item.os === "linux" ? `'${item.abi ?? "glibc"}'` : "",
      // Embed a structured ReleaseIdentity at build time. Release builds
      // (OPENCODE_RELEASE=1) with a release-context path produce a release
      // identity; otherwise a development identity is embedded. See
      // docs/DISTRIBUTION.md §5.4.
      //
      // The define must be a JSON *string* literal (double-encoded): the
      // runtime reads it as a string and JSON.parses it. A bare object
      // literal would make OPENCODE_RELEASE_IDENTITY an object at runtime,
      // which release-info.ts rejects with a fallback to the development
      // identity (bun --define inlines the expression as-is).
      OPENCODE_RELEASE_IDENTITY: JSON.stringify(
        JSON.stringify(
          buildReleaseIdentityForBuild({
            isRelease: Script.release,
            version: Script.version,
            channel,
          }),
        ),
      ),
    },
  })

  // Smoke test: verify version output for targets matching current platform
  if (item.os === process.platform && item.arch === process.arch && !item.abi) {
    const binaryPath = `${distDir}/${name}/bin/${BINARY_NAME}`
    console.log(`Running smoke test: ${binaryPath} --version`)
    try {
      const versionOutput = await $`${binaryPath} --version`.text()
      console.log(`Smoke test passed: ${versionOutput.trim()}`)
    } catch (e) {
      console.error(`Smoke test failed for ${name}:`, e)
      process.exit(1)
    }
  }

  await $`rm -rf ${distDir}/${name}/bin/tui`
  await Bun.file(`${distDir}/${name}/package.json`).write(
    JSON.stringify(
      {
        name,
        version: Script.version,
        os: [item.os],
        cpu: [item.arch],
      },
      null,
      2,
    ),
  )
  binaries[name] = Script.version
}

export { binaries }
