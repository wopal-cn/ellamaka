// packages/ellamaka-release/src/cleanup/parse.ts
//
// Pure, product-aware helpers for the cleanup CLI: argument parsing and tag
// parsing. Kept free of I/O so they are directly unit-testable (B-01, B-02).

import { parseLegacyVersion, parseReleaseVersion } from "../identity"
import type { ProductConfig } from "./types"

export type Flags = {
  product: "ellamaka-cli" | "ellamaka-desktop"
  mode: "retention" | "withdraw"
  keepStable: number
  keepBeta: number
  keepRc: number
  dryRun: boolean
  withdrawVersion: string | null
  fallback: string | null
}

export type TagParseResult =
  | { product: string; version: string; channel: "stable" | "beta"; kind: "standard" }
  | { product: string; version: string; kind: "legacy"; legacyShape: string }

/**
 * Parse a namespaced standard SemVer tag for a product. Returns null for
 * non-product tags or legacy shapes.
 *
 * githubTagPrefix already carries the full product namespace (e.g.
 * "ellamaka-cli-v"). We slice the full prefix — do NOT append another "v",
 * which would require an impossible "ellamaka-cli-vv1.2.3" tag (B-01).
 */
export function parseReleaseTag(config: ProductConfig, tag: string): TagParseResult | null {
  const prefix = config.githubTagPrefix
  if (!tag.startsWith(prefix)) return null
  const version = tag.slice(prefix.length)
  try {
    const parsed = parseReleaseVersion(version)
    return { product: config.product, version, channel: parsed.channel, kind: "standard" }
  } catch {
    return null
  }
}

/**
 * Parse a legacy tag for a product. Returns null for standard SemVer tags
 * or non-product tags.
 */
export function parseLegacyTag(config: ProductConfig, tag: string): TagParseResult | null {
  const prefix = config.githubTagPrefix
  if (!tag.startsWith(prefix)) return null
  const version = tag.slice(prefix.length)
  try {
    const legacy = parseLegacyVersion(version)
    return { product: config.product, version, kind: "legacy", legacyShape: legacy.legacyShape }
  } catch {
    if (config.product === "ellamaka-desktop" && /^\d+\.\d+\.\d+-beta\.\d+$/.test(version)) {
      return { product: config.product, version, kind: "legacy", legacyShape: "beta-iteration" }
    }
    return null
  }
}

const PRODUCT_VALUES = new Set(["ellamaka-cli", "ellamaka-desktop"])

function isNonNegativeInteger(s: string): boolean {
  return /^\d+$/.test(s)
}

/**
 * Parse CLI argv into flags. Fail-closed (B-02):
 *  - --product is required and must be one of the known products
 *  - unknown flags are rejected (e.g. --dryrun is NOT accepted, must be --dry-run)
 *  - value flags (--keep-stable/--keep-beta/--withdraw/--fallback) require a value
 *  - keep values must be finite non-negative integers (no NaN / negative)
 *
 * Returns { flags } on success, or { error } with a message and exit code.
 */
export function parseArgs(
  argv: string[],
): { flags: Flags; error?: undefined } | { error: string; exitCode: number; flags?: undefined } {
  const args = argv.slice(2)
  const flags: Flags = {
    product: null as unknown as Flags["product"],
    mode: "retention",
    keepStable: 3,
    keepBeta: 2,
    keepRc: 2,
    dryRun: false,
    withdrawVersion: null,
    fallback: null,
  }
  let productSeen = false

  const requireValue = (flag: string, value: string | undefined): string | null =>
    value === undefined ? `Error: ${flag} requires a value` : null

  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === "--product") {
      const value = args[++i]
      const missing = requireValue(a, value)
      if (missing) return { error: missing, exitCode: 2 }
      if (!PRODUCT_VALUES.has(value!)) {
        return { error: `Error: unknown --product '${value}' (expected ellamaka-cli | ellamaka-desktop)`, exitCode: 2 }
      }
      flags.product = value as Flags["product"]
      productSeen = true
    } else if (a === "--keep-stable" || a === "--keep-beta" || a === "--keep-rc") {
      const value = args[++i]
      const missing = requireValue(a, value)
      if (missing) return { error: missing, exitCode: 2 }
      if (!isNonNegativeInteger(value!)) {
        return { error: `Error: ${a} must be a non-negative integer, got '${value}'`, exitCode: 2 }
      }
      const n = Number(value)
      if (!Number.isFinite(n)) {
        return { error: `Error: ${a} must be a finite non-negative integer`, exitCode: 2 }
      }
      if (a === "--keep-stable") flags.keepStable = n
      else if (a === "--keep-beta") flags.keepBeta = n
      else flags.keepRc = n
    } else if (a === "--dry-run") {
      flags.dryRun = true
    } else if (a === "--withdraw") {
      const value = args[++i]
      const missing = requireValue(a, value)
      if (missing) return { error: missing, exitCode: 2 }
      flags.mode = "withdraw"
      flags.withdrawVersion = value!
    } else if (a === "--fallback") {
      const value = args[++i]
      const missing = requireValue(a, value)
      if (missing) return { error: missing, exitCode: 2 }
      flags.fallback = value!
    } else {
      return { error: `Error: unknown argument '${a}'`, exitCode: 2 }
    }
  }

  if (!productSeen) {
    return { error: "Error: --product <ellamaka-cli|ellamaka-desktop> is required", exitCode: 2 }
  }

  if (flags.mode === "withdraw") {
    if (!flags.withdrawVersion) return { error: "Error: --withdraw requires a version argument", exitCode: 2 }
    if (!flags.fallback) return { error: "Error: --withdraw requires --fallback <version>", exitCode: 2 }
  }

  return { flags }
}
