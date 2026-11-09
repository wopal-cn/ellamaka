import { chmodSync, cpSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { build } from "esbuild"
import { buildPublishPlan, loadPublishTargets, selectPublishTargets } from "../../../ellamaka-release/src/npm/plan"
import { createBunRuntime, packLocalTarball } from "../../../ellamaka-release/src/npm/execute"

const sdk = resolve(import.meta.dir, "..")
const repo = resolve(sdk, "../../..")
const temp = mkdtempSync(join(tmpdir(), "ellamaka-local-verify-"))
const consumer = join(temp, "consumer")
const home = join(temp, "home")
const runtime = createBunRuntime()
const nodeExec = Bun.which("node")
if (!nodeExec) throw new Error("node executable is required for local SEA verification")
function expectNoPrivateRuntimePackages(manifest: string) {
  const parsed: unknown = JSON.parse(readFileSync(manifest, "utf8"))
  if (!parsed || typeof parsed !== "object") throw new Error("SDK package manifest is not an object")
  const pkg = Object.fromEntries(Object.entries(parsed))
  for (const key of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    const value = pkg[key]
    if (!value || typeof value !== "object") continue
    for (const name of Object.keys(value)) {
      if (name === "@wopal/wopalspace" || name === "@wopal/ellamaka-core" || name === "@wopal/ellamaka-cordis")
        throw new Error(`published SDK has unpublished runtime dependency ${name}`)
    }
  }
}

function run(command: string[], cwd = temp) {
  const result = Bun.spawnSync(command, { cwd, stdin: "inherit", stdout: "inherit", stderr: "inherit" })
  if (result.exitCode !== 0) throw new Error(`${command.join(" ")} failed with ${result.exitCode}`)
}

try {
  mkdirSync(join(temp, "tarball"), { recursive: true })
  mkdirSync(consumer, { recursive: true })
  mkdirSync(home)
  const target = selectPublishTargets(loadPublishTargets(repo), ["@wopal/ellamaka-sdk"])[0]
  const entry = buildPublishPlan({
    targets: [target],
    releaseVersion: target.manifest.version,
    isPublished: () => false,
  }).entries[0]
  packLocalTarball(entry, { repoRoot: repo, stagingDir: join(temp, "tarball"), runtime, log: () => {} })
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({ name: "ellamaka-local-consumer", private: true, type: "module" }, null, 2) + "\n",
  )
  run(["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund", join(temp, "tarball", entry.tarball)], consumer)
  expectNoPrivateRuntimePackages(join(consumer, "node_modules/@wopal/ellamaka-sdk/package.json"))

  const nodeProbe = join(consumer, "probe.mjs")
  writeFileSync(
    nodeProbe,
    [
      'import { createEllamakaLocalClient } from "@wopal/ellamaka-sdk/local"',
      `const local = await createEllamakaLocalClient({ wopalHome: ${JSON.stringify(home)}, directory: ${JSON.stringify(consumer)} })`,
      "const spaces = await local.client.wopalSpace.space.list()",
      "console.log(JSON.stringify({ spaces: spaces.data, error: spaces.error }))",
      "await local.dispose()",
    ].join("\n"),
  )
  const nodeOutput = Bun.spawnSync(["node", nodeProbe], { cwd: consumer, stdout: "pipe", stderr: "inherit" })
  if (nodeOutput.exitCode !== 0) throw new Error(`Node local consumer failed with ${nodeOutput.exitCode}`)
  if (!nodeOutput.stdout.toString().includes('"items":[]'))
    throw new Error("Node local consumer returned unexpected output")

  const sea = join(temp, "sea")
  mkdirSync(join(sea, "local"), { recursive: true })
  const worker = join(consumer, "node_modules/@wopal/ellamaka-sdk/dist/local/worker.js")
  cpSync(worker, join(sea, "local/worker.js"))
  const seaEntry = join(sea, "entry.mjs")
  writeFileSync(
    seaEntry,
    [
      'import { createEllamakaLocalClient } from "@wopal/ellamaka-sdk/local"',
      'import { dirname, join } from "node:path"',
      'import { pathToFileURL } from "node:url"',
      "async function main() {",
      `  const local = await createEllamakaLocalClient({ wopalHome: ${JSON.stringify(home)}, directory: ${JSON.stringify(consumer)}, workerPath: pathToFileURL(join(dirname(process.execPath), "local", "worker.js")) })`,
      "  const spaces = await local.client.wopalSpace.space.list()",
      "  console.log(JSON.stringify({ spaces: spaces.data, error: spaces.error }))",
      "  await local.dispose()",
      "}",
      "main().catch((error) => { console.error(error); process.exitCode = 1 })",
    ].join("\n"),
  )
  await build({
    entryPoints: [seaEntry],
    absWorkingDir: consumer,
    nodePaths: [join(consumer, "node_modules")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: join(sea, "bundle.cjs"),
    external: ["node:*"],
  })
  const config = join(sea, "sea-config.json")
  writeFileSync(
    config,
    JSON.stringify(
      {
        main: join(sea, "bundle.cjs"),
        output: join(sea, "sea-prep.blob"),
        disableExperimentalSEAWarning: true,
        useCodeCache: false,
        useSnapshot: false,
      },
      null,
      2,
    ) + "\n",
  )
  run([nodeExec, "--experimental-sea-config", config])
  const binary = join(sea, "ellamaka-sdk-sea")
  cpSync(realpathSync(nodeExec), binary)
  chmodSync(binary, 0o755)
  const args = [
    "postject",
    binary,
    "NODE_SEA_BLOB",
    join(sea, "sea-prep.blob"),
    "--sentinel-fuse",
    "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
  ]
  if (process.platform === "darwin") args.push("--macho-segment-name", "NODE_SEA")
  run([resolve(repo, "node_modules/.bin/postject"), ...args.slice(1)])
  if (process.platform === "darwin") run(["codesign", "-f", "--sign", "-", binary])
  const seaOutput = Bun.spawnSync([binary], { cwd: sea, stdout: "pipe", stderr: "inherit" })
  if (seaOutput.exitCode !== 0) throw new Error(`SEA local consumer failed with ${seaOutput.exitCode}`)
  if (!seaOutput.stdout.toString().includes('"items":[]'))
    throw new Error("SEA local consumer returned unexpected output")
  console.log("local Worker clean-consumer verification passed (Node and SEA)")
} finally {
  rmSync(temp, { recursive: true, force: true })
}
