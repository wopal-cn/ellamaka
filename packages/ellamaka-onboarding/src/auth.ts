/**
 * Authentication for the mounted onboarding surface.
 *
 * The mount declares `auth: "self"`, so this module owns the whole policy.
 * The rules mirror the host server's credential model but add the extra
 * restriction the onboarding surface needs: it can mutate the machine
 * (installers, CLI subprocesses), so a non-loopback caller is blocked
 * entirely unless a server password exists to authenticate it.
 *
 * @module @wopal/ellamaka-onboarding/auth
 */
import type { IncomingMessage } from "node:http"

export interface OnboardingAuthOptions {
  /** The server password; when absent, only loopback callers are allowed. */
  serverPassword?: string
  /** The server username; defaults to `ellamaka` (mirrors the host). */
  serverUsername?: string
}

export type OnboardingAuthResult =
  | { ok: true }
  | { ok: false; status: 401; code: "UNAUTHORIZED"; message: string }
  | { ok: false; status: 403; code: "SECURITY_BLOCK"; message: string }

const DEFAULT_USERNAME = "ellamaka"
const AUTH_TOKEN_QUERY = "auth_token"

/** Addresses that always describe the local machine. */
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1", "0:0:0:0:0:0:0:1"])

function normalizeAddress(address: string | undefined): string {
  if (!address) return ""
  // IPv6 literals may arrive scoped (`fe80::1%en0`) or bracketed.
  return address
    .replace(/^\[|\]$/g, "")
    .split("%")[0]!
    .toLowerCase()
}

/** Whether the socket peer is the local machine. */
export function isLoopbackAddress(address: string | undefined): boolean {
  const normalized = normalizeAddress(address)
  if (!normalized) return false
  if (LOOPBACK_ADDRESSES.has(normalized)) return true
  // The whole 127.0.0.0/8 block is loopback.
  if (normalized.startsWith("127.")) return true
  // IPv4-mapped IPv6 loopback in any spelling.
  if (normalized.startsWith("::ffff:127.")) return true
  return false
}

function decodeBase64(value: string): string | null {
  try {
    return Buffer.from(value, "base64").toString("utf-8")
  } catch {
    return null
  }
}

interface DecodedCredentials {
  username: string
  password: string
}

function decodeCredential(encoded: string): DecodedCredentials | null {
  const decoded = decodeBase64(encoded)
  if (!decoded) return null
  const separator = decoded.indexOf(":")
  if (separator === -1) return null
  return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) }
}

/**
 * Extract credentials from a request: the `auth_token` query parameter (the
 * Workbench's URL-borne token), a Basic header, or a Bearer token.
 */
export function credentialFromRequest(req: IncomingMessage): DecodedCredentials | null {
  try {
    const url = new URL(req.url ?? "/", "http://localhost")
    const token = url.searchParams.get(AUTH_TOKEN_QUERY)
    if (token) return decodeCredential(token)
  } catch {
    // A malformed request target simply carries no query credentials.
  }

  const authorization = req.headers.authorization ?? ""
  const basic = /^Basic\s+(.+)$/i.exec(authorization)
  if (basic) return decodeCredential(basic[1]!)

  const bearer = /^Bearer\s+(.+)$/i.exec(authorization)
  if (bearer) return { username: DEFAULT_USERNAME, password: bearer[1]! }

  return null
}

/**
 * Authorize one request against the onboarding policy:
 *
 * 1. A matching credential is always accepted (any caller).
 * 2. A loopback caller is accepted only when no password is configured —
 *    with a password set, even local callers must authenticate.
 * 3. Any other caller without a configured password is blocked (403): an
 *    unauthenticated remote caller must never reach machine-mutating routes.
 */
export function checkOnboardingAuth(req: IncomingMessage, options: OnboardingAuthOptions = {}): OnboardingAuthResult {
  const password = options.serverPassword
  const username = options.serverUsername ?? DEFAULT_USERNAME

  if (password) {
    const credential = credentialFromRequest(req)
    if (credential && credential.username === username && credential.password === password) {
      return { ok: true }
    }
    return { ok: false, status: 401, code: "UNAUTHORIZED", message: "Unauthorized" }
  }

  if (isLoopbackAddress(req.socket?.remoteAddress)) return { ok: true }

  return {
    ok: false,
    status: 403,
    code: "SECURITY_BLOCK",
    message:
      "Onboarding is only available from the local machine. Set a server password (ELLAMAKA_SERVER_PASSWORD) to allow remote access.",
  }
}
