/**
 * Build the URL that the server-side TUI attach subprocess uses to reach its
 * own server. The attach process is spawned by the server on the same machine,
 * so the host is always loopback — the client-facing hostname the workbench was
 * opened with (e.g. `http://ellamac:4096`) may not resolve on the server itself.
 * The port is preserved so each server attaches to its own listener.
 *
 * Throws on missing or malformed input: `sdk.url` is a required field, and a
 * bad value must surface as a visible error (the caller falls back to chat)
 * instead of silently targeting a guessed host.
 */
export function attachUrl(clientUrl: string): string {
  const url = new URL(clientUrl.trim())
  url.hostname = "127.0.0.1"
  return url.toString().replace(/\/+$/, "")
}
