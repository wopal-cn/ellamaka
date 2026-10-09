import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { installPackage, removePackage, type InstallSpec } from "./installer.js"
import { profileDirOf } from "./compose.js"
import { readProfileManifest } from "./profile-manifest.js"
import { DEFAULT_RESOLVER_REGISTRY, packumentUrl, pickVersion, type Packument } from "./resolver.js"

export interface PackageWorkerArguments {
  action: "config" | "view" | "add" | "remove" | "install"
  spec?: string
  fields: string[]
  registry: string
  timeoutMs: number
}

function installSpec(spec: string): InstallSpec {
  if (spec.startsWith("file:")) {
    return { kind: "dir", path: spec.startsWith("file://") ? fileURLToPath(spec) : resolve(spec.slice(5)) }
  }
  if (spec.startsWith(".") || spec.startsWith("/") || /^[A-Z]:[/\\]/i.test(spec))
    return { kind: "dir", path: resolve(spec) }
  if (/^(?:git|https?|ssh|github|link):/.test(spec) || spec.includes("://"))
    throw new Error("unsupported package source: " + spec)
  const at = spec.lastIndexOf("@")
  const name = at > 0 ? spec.slice(0, at) : spec
  const version = at > 0 ? spec.slice(at + 1) : undefined
  if (!/^(@[^/\s]+\/)?[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) throw new Error("unsupported package spec: " + spec)
  return { kind: "registry", name, ...(version ? { version } : {}) }
}

/** The native package-manager dialect is parsed before any disk mutation. */
export function parsePackageWorkerArguments(args: readonly string[]): PackageWorkerArguments {
  const positional: string[] = []
  let registry = DEFAULT_RESOLVER_REGISTRY
  let timeoutMs = 20000
  for (const argument of args) {
    if (!argument.startsWith("-")) {
      positional.push(argument)
      continue
    }
    if (argument.startsWith("--registry=")) {
      const url = new URL(argument.slice("--registry=".length))
      if (!["https:", "http:"].includes(url.protocol)) throw new Error("unsupported registry")
      registry = url.href.endsWith("/") ? url.href : url.href + "/"
    } else if (argument.startsWith("--config.fetch-timeout=")) {
      timeoutMs = Number(argument.slice("--config.fetch-timeout=".length))
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("invalid fetch timeout")
    } else if (
      !/^--(?:json|frozen-lockfile|ignore-scripts|reporter=(?:append-only|ndjson|silent)|config\.fetch-(?:retries|retry-mintimeout|retry-maxtimeout)=\d+|config\.lockfile=false)$/.test(
        argument,
      )
    ) {
      throw new Error("unsupported package-worker option: " + argument)
    }
  }
  const [action, spec, ...fields] = positional
  if (!["config", "view", "add", "remove", "install"].includes(action ?? ""))
    throw new Error("unsupported package-worker action")
  if (action === "config" && positional.join(" ") !== "config get registry") throw new Error("unsupported config query")
  if (["view", "add", "remove"].includes(action!) && !spec) throw new Error(action + " requires a package")
  if (["add", "remove"].includes(action!) && fields.length) throw new Error(action + " takes one package")
  if (action === "install" && positional.length !== 1) throw new Error("install takes no package operand")
  if (action !== "config" && spec) installSpec(spec)
  if (
    action === "view" &&
    fields.some((field) => !["name", "version", "description", "dsh", "peerDependencies"].includes(field))
  )
    throw new Error("unsupported metadata field")
  return {
    action: action as PackageWorkerArguments["action"],
    spec,
    fields: action === "view" ? fields : [],
    registry,
    timeoutMs,
  }
}

export interface PackageWorkerContext {
  installAnchor?: string
  home: string
  profile: string
  cwd?: string
  signal?: AbortSignal
}

/** A scoped, engine-free operation used by the native manager's child process. */
export async function runPackageWorker(
  context: PackageWorkerContext,
  args: readonly string[],
): Promise<string | undefined> {
  const request = parsePackageWorkerArguments(args)
  const dir = profileDirOf(context.home, context.profile)
  if (context.cwd && resolve(context.cwd) !== resolve(dir))
    throw new Error("package-worker cwd does not match the profile")
  if (request.action === "config") return request.registry + "\n"
  const signal = context.signal
    ? AbortSignal.any([context.signal, AbortSignal.timeout(request.timeoutMs)])
    : AbortSignal.timeout(request.timeoutMs)
  if (request.action === "view") {
    const spec = installSpec(request.spec!)
    let manifest: Record<string, unknown>
    if (spec.kind === "dir") {
      manifest = JSON.parse(readFileSync(resolve(spec.path, "package.json"), "utf8"))
    } else {
      const response = await fetch(packumentUrl(request.registry, spec.name), {
        signal,
        headers: { accept: "application/json" },
      })
      if (!response.ok) throw new Error("registry metadata returned HTTP " + response.status)
      const packument = (await response.json()) as Packument
      manifest = pickVersion(packument, spec.version ?? "latest", []) as unknown as Record<string, unknown>
    }
    const fields = request.fields.length
      ? request.fields
      : ["name", "version", "description", "dsh", "peerDependencies"]
    return JSON.stringify(Object.fromEntries(fields.map((field) => [field, manifest[field]]))) + "\n"
  }
  context.signal?.throwIfAborted()
  if (request.action === "add") {
    await installPackage(installSpec(request.spec!), {
      home: context.home,
      profiles: [context.profile],
      registry: request.registry,
      signal: context.signal,
      installAnchor: context.installAnchor,
      profileLockHeld: true,
    })
  } else if (request.action === "remove") {
    const spec = installSpec(request.spec!)
    if (spec.kind !== "registry" || spec.version) throw new Error("remove requires an installed package name")
    await removePackage(spec.name, { home: context.home, profiles: [context.profile] })
  } else {
    if (!existsSync(dir)) throw new Error("package-worker profile is missing")
    const manifest = readProfileManifest(dir)
    for (const [name, version] of Object.entries(manifest.dependencies)) {
      context.signal?.throwIfAborted()
      await installPackage(
        { kind: "registry", name, version },
        {
          home: context.home,
          profiles: [context.profile],
          registry: request.registry,
          signal: context.signal,
          installAnchor: context.installAnchor,
          profileLockHeld: true,
        },
      )
    }
  }
  return undefined
}
