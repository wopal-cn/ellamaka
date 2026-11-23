// packages/ellamaka-release/src/manifest.ts
//
// Release manifest generation: parses archive names, builds the schema v2
// (releaseIdentity) or legacy v1 manifest, and writes manifest.json,
// checksums.txt and release-notes.md. Migrated from scripts/package-release.mjs.

import { createHash } from "crypto"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../")

function sha256(filePath: string) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")
}

function fileSize(filePath: string) {
  return fs.statSync(filePath).size
}

function toCamel(flag: string) {
  return flag.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
}

export function parseArgs(argv: string[]) {
  const args = argv.slice(2)
  const subcommand = args[0]
  if (subcommand !== "manifest") {
    throw new Error("Usage: manifest.ts manifest [options]")
  }

  const flags: Record<string, string | boolean> = {}
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!
    if (!arg.startsWith("--")) continue
    const key = toCamel(arg.slice(2))
    if (i + 1 < args.length && !args[i + 1]!.startsWith("--")) {
      flags[key] = args[++i]!
      continue
    }
    flags[key] = true
  }

  // In schema v2 mode (--release-context-path), version and tag are derived
  // from the release context; they are only required for legacy v1 calls.
  const required = ["archivesDir", "outputDir"]
  for (const key of required) {
    if (!flags[key]) throw new Error(`Missing required flag: --${key.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())}`)
  }
  if (!flags.releaseContextPath) {
    for (const key of ["version", "tag"]) {
      if (!flags[key])
        throw new Error(`Missing required flag: --${key.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())}`)
    }
  }

  return {
    subcommand,
    flags: {
      archivesDir: flags.archivesDir as string,
      version: flags.version as string | undefined,
      outputDir: flags.outputDir as string,
      tag: flags.tag as string | undefined,
      baseUrl: (flags.baseUrl as string | undefined) || "https://download.coursedao.com/ellamaka",
      build: flags.build as string | undefined,
      releaseContextPath: flags.releaseContextPath as string | undefined,
    },
  }
}

// CLI artifact naming: ellamaka-<os>-<arch>[-baseline].<ext>
//   os ∈ {darwin, linux, windows}, arch ∈ {arm64, x64}, ext ∈ {tar.gz, zip}
// Desktop artifact naming: ellamaka-desktop-<os>-<arch>.<ext>
//   os ∈ {darwin, win32, linux} (win32 normalized to windows),
//   arch ∈ {arm64, x64} — but electron-builder uses platform-specific
//   arch names for linux: amd64 (deb), x86_64 (AppImage), aarch64
//   (rpm, RPM-native arch name). All normalize to x64/arm64 in the
//   manifest. The ext set is a historical superset — rpm is no longer
//   produced, but older versioned manifests still declare it.
const CLI_ARCHIVE_RE = /^ellamaka-([^-]+)-(arm64|x64)(?:-(baseline))?\.(tar\.gz|zip)$/
const DESKTOP_ARCHIVE_RE =
  /^ellamaka-desktop-(?:beta-)?([^-]+)-(arm64|x64|amd64|x86_64|aarch64)\.(dmg|zip|exe|AppImage|deb|rpm)$/
const DESKTOP_OS_MAP: Record<string, string> = {
  darwin: "darwin",
  mac: "darwin",
  win32: "windows",
  win: "windows",
  linux: "linux",
}
const DESKTOP_ARCH_MAP: Record<string, string> = {
  arm64: "arm64",
  x64: "x64",
  amd64: "x64",
  x86_64: "x64",
  aarch64: "arm64",
}
const ARCHIVE_EXT_RE = /\.(tar\.gz|zip|dmg|exe|AppImage|deb|rpm)$/

export function parseArchiveName(filename: string): {
  os: string
  arch: string
  variant: string | null
  ext: string
  product: string
} {
  const desktopMatch = filename.match(DESKTOP_ARCHIVE_RE)
  if (desktopMatch) {
    return {
      os: DESKTOP_OS_MAP[desktopMatch[1]!] ?? desktopMatch[1]!,
      arch: DESKTOP_ARCH_MAP[desktopMatch[2]!] ?? desktopMatch[2]!,
      variant: null,
      ext: desktopMatch[3]!,
      product: "desktop",
    }
  }

  const cliMatch = filename.match(CLI_ARCHIVE_RE)
  if (cliMatch) {
    return {
      os: cliMatch[1]!,
      arch: cliMatch[2]!,
      variant: cliMatch[3] ?? null,
      ext: cliMatch[4]!,
      product: "cli",
    }
  }

  throw new Error(`Cannot parse archive name: ${filename}`)
}

function osLabel(os: string) {
  if (os === "darwin") return "macOS"
  if (os === "linux") return "Linux"
  if (os === "windows") return "Windows"
  return os
}

function archLabel(arch: string) {
  if (arch === "arm64") return "ARM64"
  if (arch === "x64") return "x64"
  return arch
}

export function buildReleaseNotes(
  version: string,
  artifacts: Array<{ product: string; ext: string; os: string; arch: string; name: string; url: string }>,
  manifestUrl: string,
  checksumsUrl: string,
) {
  const downloads = artifacts.filter((artifact) => artifact.product !== "desktop" || artifact.ext !== "zip")
  const lines = [
    "## Downloads",
    "",
    "| OS | Arch | Download |",
    "| --- | --- | --- |",
    ...downloads.map(
      (artifact) => `| ${osLabel(artifact.os)} | ${archLabel(artifact.arch)} | [${artifact.name}](${artifact.url}) |`,
    ),
    "",
    "## Verification",
    "",
    `- Manifest: ${manifestUrl}`,
    `- Checksums: ${checksumsUrl}`,
    "",
  ]

  return lines.join("\n")
}

/**
 * Build the manifest object. When releaseContextPath is provided, emits
 * schema v2 with a structured releaseIdentity. Otherwise emits the legacy
 * v1 shape (version + optional build + artifacts) for backward compat.
 *
 * Per docs/DISTRIBUTION.md §5.3, the top-level `version` must equal
 * `releaseIdentity.version` in schema v2.
 */
export function buildManifest({
  version,
  tag,
  artifacts,
  checksumsUrl,
  baseUrl,
  build,
  releaseContextPath,
}: {
  version: string
  tag?: string
  artifacts: unknown[]
  checksumsUrl: string
  baseUrl: string
  build?: string
  releaseContextPath?: string
}): {
  manifestSchemaVersion?: number
  version: string
  build?: string
  releaseIdentity?: {
    schemaVersion: number
    kind: unknown
    product: unknown
    version: string
    channel: unknown
    upstream: unknown
    build: unknown
  }
  artifacts: unknown[]
  checksumsUrl: string
} {
  if (releaseContextPath) {
    const ctx = JSON.parse(fs.readFileSync(releaseContextPath, "utf8"))
    if (ctx.version !== version) {
      throw new Error(`release context version ${ctx.version} does not match --version ${version}`)
    }
    const manifest = {
      manifestSchemaVersion: 2,
      version,
      releaseIdentity: {
        schemaVersion: 2,
        kind: ctx.kind,
        product: ctx.product,
        version: ctx.version,
        channel: ctx.channel,
        upstream: ctx.upstream,
        build: ctx.build,
      },
      artifacts,
      checksumsUrl,
    }
    return manifest
  }
  // Legacy v1 shape
  return {
    version,
    ...(build ? { build } : {}),
    artifacts,
    checksumsUrl,
  }
}

export function manifestCommand(flags: {
  archivesDir: string
  version?: string
  outputDir: string
  tag?: string
  baseUrl?: string
  build?: string
  releaseContextPath?: string
}) {
  const archivesDir = path.resolve(projectRoot, flags.archivesDir)
  const outputDir = path.resolve(projectRoot, flags.outputDir)
  const baseUrl = flags.baseUrl || "https://download.coursedao.com/ellamaka"

  // Schema v2 (--release-context-path): version/tag are derived from the
  // release context so the manifest can never desync from the build. An
  // explicit --version (legacy callers) may only assert equality with the
  // context — it cannot override it. The versioned path is always v<version>
  // per DISTRIBUTION.md §7.1.
  let version = flags.version
  let tag = flags.tag
  if (flags.releaseContextPath) {
    const ctx = JSON.parse(fs.readFileSync(flags.releaseContextPath, "utf8"))
    if (!ctx.version) throw new Error(`release context ${flags.releaseContextPath} has no version`)
    if (version !== undefined && version !== ctx.version) {
      throw new Error(`release context version ${ctx.version} does not match --version ${version}`)
    }
    version = ctx.version
    tag = flags.tag ?? `v${ctx.version}`
  }

  if (!fs.existsSync(archivesDir)) throw new Error(`Archives directory not found: ${archivesDir}`)

  const files = fs
    .readdirSync(archivesDir)
    .filter((file) => file.startsWith("ellamaka-") && ARCHIVE_EXT_RE.test(file))
    .sort()

  // Fail fast on naming drift: every archive-shaped file must parse. A
  // silent skip would upload an undeclared artifact (or leave it out of
  // the manifest) — both are release-integrity bugs. Stray non-archive
  // files (updater feeds, blockmaps) never reach this check.
  for (const file of files) {
    try {
      parseArchiveName(file)
    } catch {
      throw new Error(
        `Cannot parse archive name: ${file} — update the archive regexes in packages/ellamaka-release/src/manifest.ts or fix the artifact naming`,
      )
    }
  }

  if (files.length === 0)
    throw new Error("No archive files found matching ellamaka-*-*.{tar.gz,zip,dmg,exe,AppImage,deb,rpm}")

  const versionBaseUrl = `${baseUrl}/v${version}`
  const manifestUrl = `${versionBaseUrl}/manifest.json`
  const checksumsUrl = `${versionBaseUrl}/checksums.txt`
  const artifacts = files.map((file) => {
    const filePath = path.join(archivesDir, file)
    const parsed = parseArchiveName(file)
    return {
      name: file,
      os: parsed.os,
      arch: parsed.arch,
      variant: parsed.variant,
      ext: parsed.ext,
      product: parsed.product,
      url: `${versionBaseUrl}/${file}`,
      sha256: sha256(filePath),
      size: fileSize(filePath),
    }
  })

  const manifest = buildManifest({
    version: version!,
    tag: tag!,
    artifacts,
    checksumsUrl,
    baseUrl,
    build: flags.build,
    releaseContextPath: flags.releaseContextPath,
  })
  const checksumLines = artifacts.map((artifact) => `${artifact.sha256}  ${artifact.name}`)

  fs.mkdirSync(outputDir, { recursive: true })
  fs.writeFileSync(path.join(outputDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n")
  fs.writeFileSync(path.join(outputDir, "checksums.txt"), checksumLines.join("\n") + "\n")
  fs.writeFileSync(
    path.join(outputDir, "release-notes.md"),
    buildReleaseNotes(version!, artifacts, manifestUrl, checksumsUrl),
  )

  console.log(`Generated: ${path.join(outputDir, "manifest.json")}`)
  console.log(`Generated: ${path.join(outputDir, "checksums.txt")}`)
  console.log(`Generated: ${path.join(outputDir, "release-notes.md")}`)
  console.log(`Artifacts: ${artifacts.length}`)

  return { manifest, artifacts }
}
