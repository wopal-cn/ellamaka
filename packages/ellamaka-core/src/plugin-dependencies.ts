import { randomBytes } from "node:crypto"
import path from "node:path"
import { existsSync, realpathSync } from "node:fs"
import { access, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises"
import npa from "npm-package-arg"
import semver from "semver"
import { Effect, Layer } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import { AppFileSystem } from "./filesystem"
import { Global } from "./global"
import { InstallationLocal, InstallationVersionBase } from "./installation/version"
import { Npm } from "./npm"
import type { CorePreparationContributor, PreparationTarget } from "./preparation"
import { EffectFlock } from "./util/effect-flock"
import { Glob } from "./util/glob"

export type InstallDependency = {
  name: string
  version?: string
}

type PluginDependencySnapshot = {
  path: string
  deps: Record<string, string>
}

type DirectoryDependencyState = {
  fingerprint: string
  installed_at: number
  plugins: Record<string, PluginDependencySnapshot>
}

type PluginDependencyState = {
  version: 1
  dirs: Record<string, DirectoryDependencyState>
}

type StateRead = { kind: "ok"; state: PluginDependencyState } | { kind: "corrupt"; content: string }

export type CollectedPluginDependencies = {
  deps: InstallDependency[]
  fingerprint: string
  plugins: Record<string, PluginDependencySnapshot>
}

const STATE_CORRUPT = "PLUGIN_DEPENDENCY_STATE_CORRUPT"
const INSTALL_FAILED = "PLUGIN_DEPENDENCY_INSTALL_FAILED"
const INPUT_CHANGED = "PLUGIN_DEPENDENCY_INPUT_CHANGED"
const PREFLIGHT_FAILED = "PLUGIN_DEPENDENCY_PREFLIGHT_FAILED"
const ABORTED = "PREPARATION_CANCELLED"
const MAX_INPUT_RETRIES = 3
const HOST_PLUGIN_CONTRACT = "@wopal/ellamaka-plugin"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseRecord(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function isPluginDependencyState(value: unknown): value is PluginDependencyState {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.dirs)) return false
  for (const entry of Object.values(value.dirs)) {
    if (!isRecord(entry) || typeof entry.fingerprint !== "string" || typeof entry.installed_at !== "number") {
      return false
    }
    if (!isRecord(entry.plugins)) return false
  }
  return true
}

function stateDirectory(wopalHome: string) {
  return path.join(wopalHome, "ellamaka", "state")
}

function statePath(wopalHome: string) {
  return path.join(stateDirectory(wopalHome), "plugin-deps.json")
}

function lockDirectory(wopalHome: string) {
  return path.join(stateDirectory(wopalHome), "locks")
}

function canonicalPath(input: string): string {
  const resolved = path.resolve(input)
  try {
    return realpathSync.native(resolved)
  } catch {
    return resolved
  }
}

function targetDirectory(target: PreparationTarget): string {
  if (target.kind !== "instance") throw new Error("instance plugin dependency contributor received a host target")
  return canonicalPath(target.directory)
}

function dependencyDirectories(wopalHome: string, target: PreparationTarget): string[] {
  const spaceRoot = targetDirectory(target)
  return [canonicalPath(wopalHome), path.join(spaceRoot, ".wopal")]
}

function hashDependencies(deps: InstallDependency[]): string {
  const text = deps
    .map((dep) => `${dep.name}@${dep.version ?? ""}`)
    .sort()
    .join(",")
  let hash = 5381
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(index)) >>> 0
  }
  return hash.toString(16)
}

function hasInstallRequirements(collected: CollectedPluginDependencies): boolean {
  return (
    collected.deps.length > 0 ||
    Object.values(collected.plugins).some((plugin) => Object.hasOwn(plugin.deps, HOST_PLUGIN_CONTRACT))
  )
}

export async function collectPluginDependencies(dir: string): Promise<CollectedPluginDependencies> {
  const plugins: Record<string, PluginDependencySnapshot> = {}
  const resolved = new Map<string, string>()

  // Preserve the historical declaration precedence deterministically: the
  // plural `plugins/` layer overrides the singular compatibility `plugin/`
  // layer. Glob enumeration order is filesystem-dependent, so scan each layer
  // explicitly and sort within it before applying last-declaration-wins.
  for (const parent of ["plugin", "plugins"] as const) {
    const manifests = await Glob.scan(`${parent}/*/package.json`, {
      cwd: dir,
      absolute: true,
    })
    for (const packagePath of manifests.sort()) {
      const json = await readFile(packagePath, "utf8")
        .then(parseRecord)
        .catch(() => undefined)
      if (!json) continue
      const name = typeof json.name === "string" ? json.name.trim() : undefined
      if (!name) continue
      const deps =
        json.dependencies && typeof json.dependencies === "object" && !Array.isArray(json.dependencies)
          ? Object.fromEntries(
              Object.entries(json.dependencies).filter(
                (entry): entry is [string, string] => typeof entry[1] === "string",
              ),
            )
          : {}
      plugins[name] = { path: path.relative(dir, packagePath), deps }
      for (const [dependency, version] of Object.entries(deps)) {
        if (dependency === HOST_PLUGIN_CONTRACT) continue
        resolved.set(dependency, version)
      }
    }
  }

  const deps = Array.from(resolved, ([name, version]) => ({ name, version })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )
  return { deps, fingerprint: hashDependencies(deps), plugins }
}

async function readState(wopalHome: string): Promise<StateRead> {
  const file = statePath(wopalHome)
  if (!existsSync(file)) return { kind: "ok", state: { version: 1, dirs: {} } }
  const content = await readFile(file, "utf8").catch(() => "")
  try {
    const parsed: unknown = JSON.parse(content)
    if (!isPluginDependencyState(parsed)) return { kind: "corrupt", content }
    return { kind: "ok", state: parsed }
  } catch {
    return { kind: "corrupt", content }
  }
}

async function backupCorruptState(wopalHome: string, content: string): Promise<PluginDependencyState> {
  const file = statePath(wopalHome)
  if (!existsSync(file)) return { version: 1, dirs: {} }
  const suffix = new Date().toISOString().replace(/[:.]/g, "-")
  const backup = `${file}.bak.${suffix}`
  try {
    await rename(file, backup)
  } catch {
    await writeFile(backup, content, "utf8").catch(() => undefined)
    await unlink(file).catch(() => undefined)
  }
  return { version: 1, dirs: {} }
}

async function writeState(wopalHome: string, state: PluginDependencyState): Promise<void> {
  const file = statePath(wopalHome)
  const dir = path.dirname(file)
  await mkdir(dir, { recursive: true })
  const temporary = `${file}.${randomBytes(8).toString("hex")}.tmp`
  await writeFile(temporary, JSON.stringify(state, null, 2), "utf8")
  try {
    await rename(temporary, file)
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

function dependencyVersionMatches(name: string, spec: string | undefined, actual: string | undefined): boolean {
  if (!spec || !actual) return true
  try {
    const parsed = npa.resolve(name, spec)
    if (parsed.type === "version") return actual === parsed.fetchSpec
    if (parsed.type === "range") return semver.valid(actual) !== null && semver.satisfies(actual, parsed.fetchSpec)
    return true
  } catch {
    return false
  }
}

async function dependencyResolves(dir: string, dependency: InstallDependency): Promise<boolean> {
  const packageFile = path.join(dir, "node_modules", ...dependency.name.split("/"), "package.json")
  const manifest = await readFile(packageFile, "utf8")
    .then(parseRecord)
    .catch(() => undefined)
  if (!manifest || manifest.name !== dependency.name) return false
  const version = typeof manifest.version === "string" ? manifest.version : undefined
  if (!dependencyVersionMatches(dependency.name, dependency.version, version)) return false

  try {
    await realpath(Bun.resolveSync(dependency.name, dir))
    return true
  } catch {
    return false
  }
}

function installDependencies(deps: InstallDependency[]): InstallDependency[] {
  return [
    {
      name: HOST_PLUGIN_CONTRACT,
      version: InstallationLocal ? undefined : InstallationVersionBase,
    },
    ...deps,
  ]
}

async function installManifestMatches(dir: string, deps: InstallDependency[]): Promise<boolean> {
  const manifest = await readFile(path.join(dir, "package.json"), "utf8")
    .then(parseRecord)
    .catch(() => undefined)
  if (!manifest || !isRecord(manifest.dependencies)) return false
  for (const dependency of installDependencies(deps)) {
    const expected = dependency.version ?? "latest"
    if (manifest.dependencies[dependency.name] !== expected) return false
  }
  return true
}

async function preflight(dir: string, deps: InstallDependency[]): Promise<boolean> {
  if (!existsSync(path.join(dir, "node_modules"))) return false
  if (!(await installManifestMatches(dir, deps))) return false
  for (const dependency of installDependencies(deps)) {
    if (!(await dependencyResolves(dir, dependency))) return false
  }
  return true
}

async function writeInstallManifest(dir: string, deps: InstallDependency[]): Promise<void> {
  const dependencies: Record<string, string> = {}
  for (const dependency of installDependencies(deps)) dependencies[dependency.name] = dependency.version ?? "latest"
  await writeFile(path.join(dir, "package.json"), JSON.stringify({ dependencies }, null, 2), "utf8")
}

async function ensureInstallGitignore(dir: string): Promise<void> {
  const gitignore = path.join(dir, ".gitignore")
  if (existsSync(gitignore)) return
  await writeFile(
    gitignore,
    ["node_modules", "package.json", "package-lock.json", "bun.lock", ".gitignore"].join("\n"),
    "utf8",
  )
}

function infrastructure(wopalHome: string) {
  const state = stateDirectory(wopalHome)
  const cache = path.join(wopalHome, "ellamaka", "cache")
  const global = Global.layerWith({ wopalHome, state, cache })
  const flock = EffectFlock.layer.pipe(
    Layer.provide(AppFileSystem.layer),
    Layer.provide(global),
    Layer.provide(NodeFileSystem.layer),
  )
  const npm = Npm.layer.pipe(
    Layer.provide(flock),
    Layer.provide(AppFileSystem.layer),
    Layer.provide(global),
    Layer.provide(NodeFileSystem.layer),
  )
  return { flock, npm }
}

function withPreparationLock<A>(wopalHome: string, key: string, body: () => Promise<A>): Promise<A> {
  const layers = infrastructure(wopalHome)
  return Effect.gen(function* () {
    const flock = yield* EffectFlock.Service
    return yield* flock.withLock(Effect.promise(body), key, lockDirectory(wopalHome))
  }).pipe(Effect.scoped, Effect.provide(layers.flock), Effect.runPromise)
}

function runInstall(wopalHome: string, dir: string, deps: InstallDependency[]): Promise<void> {
  const layers = infrastructure(wopalHome)
  return Effect.gen(function* () {
    const npm = yield* Npm.Service
    yield* npm.install(dir, { add: installDependencies(deps) })
  }).pipe(Effect.scoped, Effect.provide(layers.npm), Effect.runPromise)
}

async function currentDirectoryState(wopalHome: string, dir: string, collected: CollectedPluginDependencies) {
  const state = await readState(wopalHome)
  if (state.kind === "corrupt") return { state: "DEGRADED" as const, code: STATE_CORRUPT }
  const cached = state.state.dirs[canonicalPath(dir)]
  if (!cached || cached.fingerprint !== collected.fingerprint) return { state: "NEEDS_PREPARATION" as const }
  if (!(await preflight(dir, collected.deps))) return { state: "NEEDS_PREPARATION" as const }
  return { state: "READY" as const }
}

async function inspectTarget(wopalHome: string, target: PreparationTarget) {
  for (const dir of dependencyDirectories(wopalHome, target)) {
    if (!existsSync(dir)) continue
    const collected = await collectPluginDependencies(dir)
    if (!hasInstallRequirements(collected)) continue
    const result = await currentDirectoryState(wopalHome, dir, collected)
    if (result.state !== "READY") return result
  }
  return { state: "READY" as const }
}

async function commitFingerprint(
  wopalHome: string,
  dir: string,
  expected: CollectedPluginDependencies,
): Promise<"committed" | "changed"> {
  return withPreparationLock(wopalHome, "plugin-dependencies:state", async () => {
    const latest = await collectPluginDependencies(dir)
    if (latest.fingerprint !== expected.fingerprint) return "changed"
    const stateRead = await readState(wopalHome)
    const state =
      stateRead.kind === "corrupt" ? await backupCorruptState(wopalHome, stateRead.content) : stateRead.state
    state.dirs[canonicalPath(dir)] = {
      fingerprint: expected.fingerprint,
      installed_at: Date.now(),
      plugins: expected.plugins,
    }
    await writeState(wopalHome, state)
    return "committed"
  })
}

async function prepareDirectory(
  wopalHome: string,
  dir: string,
  signal: AbortSignal,
  report: (progress: { phase: string; current?: number; total?: number; unit?: string }) => void,
) {
  return withPreparationLock(wopalHome, `plugin-dependencies:dir:${canonicalPath(dir)}`, async () => {
    for (let attempt = 0; attempt < MAX_INPUT_RETRIES; attempt += 1) {
      if (signal.aborted) return { state: "DEGRADED" as const, code: ABORTED }
      const collected = await collectPluginDependencies(dir)
      if (!hasInstallRequirements(collected)) return { state: "READY" as const }

      const existing = await currentDirectoryState(wopalHome, dir, collected)
      if (existing.state === "READY") return existing

      // A missing/stale cache is not proof that installation is missing. If the
      // actual dependency artifacts already resolve for the current declaration,
      // preparation only needs to publish the verified fingerprint.
      if (await preflight(dir, collected.deps)) {
        const latest = await collectPluginDependencies(dir)
        if (latest.fingerprint !== collected.fingerprint) continue
        await ensureInstallGitignore(dir)
        if ((await commitFingerprint(wopalHome, dir, collected)) === "changed") continue
        report({ phase: "ready" })
        return { state: "READY" as const }
      }

      const stateRead = await readState(wopalHome)
      if (stateRead.kind === "corrupt") {
        await withPreparationLock(wopalHome, "plugin-dependencies:state", async () => {
          const latest = await readState(wopalHome)
          if (latest.kind === "corrupt") await backupCorruptState(wopalHome, latest.content)
        })
      }

      report({ phase: "installing" })
      try {
        await access(dir)
        await ensureInstallGitignore(dir)
        await unlink(path.join(dir, "package-lock.json")).catch(() => undefined)
        await runInstall(wopalHome, dir, collected.deps)
        await writeInstallManifest(dir, collected.deps)
      } catch {
        return { state: "DEGRADED" as const, code: INSTALL_FAILED }
      }

      if (!(await preflight(dir, collected.deps))) {
        return { state: "DEGRADED" as const, code: PREFLIGHT_FAILED }
      }

      const latest = await collectPluginDependencies(dir)
      if (latest.fingerprint !== collected.fingerprint) continue
      if ((await commitFingerprint(wopalHome, dir, collected)) === "changed") continue
      report({ phase: "ready" })
      return { state: "READY" as const }
    }
    return { state: "DEGRADED" as const, code: INPUT_CHANGED }
  })
}

export function createInstanceDependencyContributor(options: { wopalHome: string }): CorePreparationContributor {
  const configuredHome = path.resolve(options.wopalHome)
  return {
    step: "instance.plugin-dependencies",
    target: "instance",
    inspect: (target) => inspectTarget(canonicalPath(configuredHome), target),
    prepare: async (target, context) => {
      const wopalHome = canonicalPath(configuredHome)
      const dirs = dependencyDirectories(wopalHome, target)
      for (let index = 0; index < dirs.length; index += 1) {
        const dir = dirs[index]
        if (!existsSync(dir)) continue
        const result = await prepareDirectory(wopalHome, dir, context.signal, (progress) =>
          context.report({ ...progress, current: index + 1, total: dirs.length, unit: "directory" }),
        )
        if (result.state !== "READY") return result
      }
      return { state: "READY" }
    },
  }
}
