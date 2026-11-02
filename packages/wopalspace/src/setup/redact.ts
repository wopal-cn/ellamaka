const BEARER = /\b(Bearer|token|password|api[_-]?key|secret)\s*[:=]?\s*[A-Za-z0-9._-]{6,}/gi
const GITHUB_TOKEN = /\bgh[pousr]_[A-Za-z0-9]{8,}/g
const CREDENTIAL_URL = /https?:\/\/[^/\s@]+@/gi
const SK_KEY = /\bsk-[A-Za-z0-9_-]{8,}/g

/**
 * Remove credential-looking values from any text that may leave setup:
 * plan, state, events, errors and results.
 */
export function redactSecret(text: string): string {
  return text
    .replace(CREDENTIAL_URL, (match) => (match.toLowerCase().startsWith("https") ? "https://" : "http://"))
    .replace(GITHUB_TOKEN, "[redacted]")
    .replace(SK_KEY, "[redacted]")
    .replace(BEARER, (_match, prefix: string) => prefix + " [redacted]")
}
