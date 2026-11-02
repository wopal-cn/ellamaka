import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { parse } from "jsonc-parser"
import { updateSettingsEntries } from "../settings-registry"
import { mergeEnvVariable, writeFileAtomic } from "./files"
import { withFileLock } from "./lock"
import type { SetupCredentialStore, SetupFoundationPort, SetupHomeSeedPort } from "./types"

export const HOME_CAPABILITY_ROOTS = ["agents", "skills", "rules", "commands"] as const

export function fileFoundation(wopalHome: string): SetupFoundationPort {
  return {
    async ensure() {
      const created = existsSync(wopalHome) ? [] : ["."]
      mkdirSync(wopalHome, { recursive: true })
      return { path: wopalHome, created }
    },
  }
}

function parseObject(text: string, source: string): Record<string, unknown> {
  const errors: { error: number; offset: number; length: number }[] = []
  const parsed: unknown = parse(text, errors, { allowTrailingComma: true, disallowComments: false })
  if (errors.length > 0 || !isRecord(parsed)) throw new Error(source + " is not a valid JSONC object")
  return parsed
}

/** Seed Home config and the user-owned capability roots after Ontology install. */
export function fileHomeSeed(wopalHome: string): SetupHomeSeedPort {
  return {
    async seed(ontologyPath: string) {
      const sourcePath = join(ontologyPath, "config", "settings.jsonc")
      let sourceText: string
      try {
        sourceText = readFileSync(sourcePath, "utf8")
      } catch (error) {
        throw new Error("Ontology settings are unavailable at " + sourcePath, { cause: error })
      }
      const source = parseObject(sourceText, "Ontology settings")
      if (!isRecord(source.ellamaka)) throw new Error("Ontology settings have no usable ellamaka block")
      const sourceEllamaka = source.ellamaka

      for (const directory of HOME_CAPABILITY_ROOTS) {
        const target = join(wopalHome, directory)
        if (!existsSync(target)) continue
        if (!statSync(target).isDirectory()) {
          throw new Error("Home capability root is not a directory: " + directory)
        }
      }

      const settingsPath = join(wopalHome, "config", "settings.jsonc")
      const changed = updateSettingsEntries(settingsPath, (document) => {
        if (!isRecord(document)) throw new Error("Home settings are not a JSON object")
        const current = document.ellamaka
        if (current === undefined) return [{ keyPath: ["ellamaka"], value: sourceEllamaka }]
        if (!isRecord(current)) throw new Error("Home settings ellamaka block is not a JSON object")
        return Object.entries(sourceEllamaka).flatMap(([key, value]) =>
          Object.prototype.hasOwnProperty.call(current, key) ? [] : [{ keyPath: ["ellamaka", key], value }],
        )
      })

      const created: string[] = []
      for (const directory of HOME_CAPABILITY_ROOTS) {
        const target = join(wopalHome, directory)
        if (existsSync(target)) continue
        mkdirSync(target, { recursive: true })
        created.push(directory)
      }
      return { settings: { path: settingsPath, changed }, capabilities: { created } }
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** A file that exists but cannot be read, or whose content is not usable. */
type ReadResult =
  | { readonly status: "absent" }
  | { readonly status: "ok"; readonly text: string }
  | { readonly status: "unreadable"; readonly reason: string }

function readCredentialFile(file: string): ReadResult {
  let text: string
  try {
    text = readFileSync(file, "utf8")
  } catch (error) {
    if (isMissing(error)) return { status: "absent" }
    return { status: "unreadable", reason: error instanceof Error ? error.message : String(error) }
  }
  return { status: "ok", text }
}

function isMissing(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false
  return error.code === "ENOENT"
}

function readAuthProviders(
  read: ReadResult,
): { ok: true; providers: Record<string, unknown> } | { ok: false; reason: string } {
  if (read.status === "absent") return { ok: true, providers: {} }
  if (read.status === "unreadable") {
    return { ok: false, reason: "auth.json cannot be read (" + read.reason + ")" }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(read.text)
  } catch {
    return {
      ok: false,
      reason: "auth.json is not valid JSON; repair or remove it before setup writes provider credentials",
    }
  }
  if (!isRecord(parsed)) {
    return {
      ok: false,
      reason: "auth.json does not hold a JSON object; repair or remove it before setup writes provider credentials",
    }
  }
  return { ok: true, providers: { ...parsed } }
}

/**
 * Credential files setup owns: GITHUB_TOKEN in WOPAL_HOME/.env and provider
 * keys in ellamaka/data/auth.json.
 *
 * Every merge runs under the file's own cross-process lock, so a Server, a
 * local-transport worker and a restart cannot interleave read → write and drop
 * another writer's token or provider. A file that cannot be read, or that is not
 * a usable document, fails closed: the original bytes stay untouched and no
 * secret is written into a fresh file that would replace the user's data.
 * Values never leave this module through a return value or a result object.
 */
export function fileCredentials(
  wopalHome: string,
  options: { readonly lockTimeoutMs?: number } = {},
): SetupCredentialStore {
  const lock = { timeoutMs: options.lockTimeoutMs }
  const envPath = join(wopalHome, ".env")
  const authPath = join(wopalHome, "ellamaka", "data", "auth.json")
  return {
    async setGithubToken(token) {
      try {
        return withFileLock(
          envPath,
          () => {
            const read = readCredentialFile(envPath)
            if (read.status === "unreadable") {
              return { ok: false as const, reason: ".env cannot be read (" + read.reason + ")" }
            }
            const existed = read.status === "ok"
            writeFileAtomic(envPath, mergeEnvVariable(existed ? read.text : "", "GITHUB_TOKEN", token))
            return { ok: true as const, created: !existed, path: envPath }
          },
          lock,
        )
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) }
      }
    },
    async providerIds() {
      // Only credential-shaped entries count as a configured provider;
      // unrelated keys in auth.json stay untouched and uninterpreted.
      const parsed = readAuthProviders(readCredentialFile(authPath))
      if (!parsed.ok) return []
      return Object.entries(parsed.providers)
        .filter(([, entry]) => isRecord(entry) && typeof entry.key === "string")
        .map(([providerId]) => providerId)
        .sort()
    },
    async setProviderKey({ providerId, apiKey }) {
      try {
        return withFileLock(
          authPath,
          () => {
            const read = readCredentialFile(authPath)
            const existing = readAuthProviders(read)
            if (!existing.ok) return { ok: false as const, reason: existing.reason }
            const merged = { ...existing.providers, [providerId]: { type: "api", key: apiKey } }
            writeFileAtomic(authPath, JSON.stringify(merged, null, 2) + "\n")
            return { ok: true as const, created: read.status === "absent", path: authPath }
          },
          lock,
        )
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) }
      }
    },
  }
}
