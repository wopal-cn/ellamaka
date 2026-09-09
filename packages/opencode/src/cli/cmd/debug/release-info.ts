// packages/opencode/src/cli/cmd/debug/release-info.ts
//
// `ellamaka debug release-info --json --api-version 1`
//
// Read-only machine interface that outputs the embedded ReleaseIdentity as a
// single JSON envelope on stdout. Does not access the network, does not read
// install receipts. Per docs/DISTRIBUTION.md §5.4.
//
// The identity is embedded at build time via the OPENCODE_RELEASE_IDENTITY
// define (a JSON string). Development builds produce a development identity
// with channel "local".

import { cmd } from "../cmd"
import { parseReleaseIdentity, ReleaseIdentityError } from "@wopal/ellamaka-release/identity"

// OPENCODE_VERSION / OPENCODE_CHANNEL are declared globally by
// packages/ellamaka-core/src/installation/version.ts. OPENCODE_RELEASE_IDENTITY is
// declared by @wopal/ellamaka-release/identity.

export type ReleaseInfoEnvelope = {
  apiVersion: 1
  releaseIdentity: unknown
}

export type ReleaseInfoErrorEnvelope = {
  apiVersion: 1
  error: { code: string; message: string }
}

export class ReleaseInfoError extends Error {
  readonly code: string
  readonly detail: string
  constructor(code: string, message: string) {
    super(`${code}: ${message}`)
    this.name = "ReleaseInfoError"
    this.code = code
    this.detail = message
  }
  toEnvelope(): ReleaseInfoErrorEnvelope {
    return { apiVersion: 1, error: { code: this.code, message: this.detail } }
  }
}

/** Parse the requested api-version. Only 1 is currently supported. */
export function parseApiVersion(raw: string | undefined): 1 {
  if (raw === undefined || raw === "1") return 1
  throw new ReleaseInfoError("EAPIVERSION", `unsupported api-version ${raw}; supported: 1`)
}

function localDevIdentity(): unknown {
  const version =
    typeof OPENCODE_VERSION === "string" && OPENCODE_VERSION ? OPENCODE_VERSION : "0.0.0-dev"
  const channel =
    typeof OPENCODE_CHANNEL === "string" && OPENCODE_CHANNEL ? OPENCODE_CHANNEL : "local"
  const devChannel = ["main", "prod", "local"].includes(channel) ? channel : "local"
  const identity: Record<string, unknown> = {
    schemaVersion: 2,
    kind: "development",
    product: "ellamaka-cli",
    version,
    channel: devChannel,
  }
  // Dev identity may carry gitCommit/builtAt if available at build time, but
  // must not carry sourceTag or workflowRunId.
  return identity
}

function readEmbeddedIdentity(): unknown {
  if (typeof OPENCODE_RELEASE_IDENTITY !== "string" || !OPENCODE_RELEASE_IDENTITY) {
    return null
  }
  try {
    return JSON.parse(OPENCODE_RELEASE_IDENTITY)
  } catch {
    throw new ReleaseInfoError("EPARSE", "embedded release identity is not valid JSON")
  }
}

/**
 * Build the release-info envelope. Pure function for testability. Throws
 * ReleaseInfoError on any validation failure.
 */
export function buildReleaseInfoEnvelope(opts: {
  identity: unknown
}): ReleaseInfoEnvelope {
  let identity = opts.identity
  if (!identity) {
    identity = localDevIdentity()
  }
  if (typeof identity !== "object" || identity === null) {
    throw new ReleaseInfoError("EPARSE", "identity is not an object")
  }
  const raw = identity as Record<string, unknown>
  if (raw.product !== undefined && raw.product !== "ellamaka-cli") {
    throw new ReleaseInfoError("EPRODUCT", `identity product ${String(raw.product)} is not ellamaka-cli`)
  }
  // parseReleaseIdentity throws ReleaseIdentityError; wrap it so the command
  // returns a stable envelope.
  let parsed: unknown
  try {
    parsed = parseReleaseIdentity(raw as Parameters<typeof parseReleaseIdentity>[0])
  } catch (err) {
    if (err instanceof ReleaseIdentityError) {
      throw new ReleaseInfoError(err.code, err.message)
    }
    throw new ReleaseInfoError("EPARSE", `identity validation failed: ${(err as Error).message}`)
  }
  return {
    apiVersion: 1,
    releaseIdentity: parsed,
  }
}

export const ReleaseInfoCommand = cmd({
  command: "release-info",
  describe: "output structured release identity as JSON (machine interface)",
  builder: (yargs) =>
    yargs
      .option("json", { type: "boolean", description: "output JSON envelope (required)", demandOption: true })
      .option("api-version", { type: "string", description: "envelope api-version", default: "1" }),
  handler(argv) {
    let apiVersion: 1
    try {
      apiVersion = parseApiVersion((argv as { "api-version"?: string })["api-version"])
    } catch (err) {
      const e = err as ReleaseInfoError
      const envelope: ReleaseInfoErrorEnvelope = { apiVersion: 1, error: { code: e.code, message: e.message } }
      process.stdout.write(JSON.stringify(envelope) + "\n")
      process.exit(1)
    }

    try {
      const identity = readEmbeddedIdentity()
      const envelope = buildReleaseInfoEnvelope({ identity })
      void apiVersion
      process.stdout.write(JSON.stringify(envelope) + "\n")
    } catch (err) {
      const e = err as ReleaseInfoError
      const envelope = e instanceof ReleaseInfoError ? e.toEnvelope() : { apiVersion: 1, error: { code: "EUNKNOWN", message: (err as Error).message } }
      process.stdout.write(JSON.stringify(envelope) + "\n")
      process.exit(1)
    }
  },
})

export * as ReleaseIdentity from "@wopal/ellamaka-release/identity"
