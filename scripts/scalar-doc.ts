#!/usr/bin/env bun

/**
 * API Reference — Scalar UI with a live OpenAPI spec
 *
 * The spec is generated from the current source at startup, so the reference
 * always matches the routes on disk. There is no committed openapi.json
 * snapshot to keep in sync.
 *
 * Usage:
 *   bun run scripts/scalar-doc.ts               → http://localhost:4100 (opens the browser)
 *   bun run scripts/scalar-doc.ts --no-open     → serve only
 *   SCALAR_PORT=8080 SCALAR_API=http://127.0.0.1:3000 bun run scripts/scalar-doc.ts
 *
 * "Try it out" proxies to ellamaka, so start the backend first with
 * `./scripts/dev.sh serve` (default 127.0.0.1:4096).
 */

import { serve } from "bun"
import { generatedOpenApi } from "../packages/opencode/src/server/routes/instance/httpapi/openapi"

const PORT = Number(process.env.SCALAR_PORT) || 4100
const API_SERVER = process.env.SCALAR_API || "http://127.0.0.1:4096"
const SPEC_PATH = "/api/doc.json"
const OPEN_BROWSER = !process.argv.includes("--no-open")

const spec = JSON.stringify(generatedOpenApi(), null, 2)

const HTML = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>ellamaka API Reference</title>
    <style>body { margin: 0; padding: 0; }</style>
  </head>
  <body>
    <div id="app"></div>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
    <script>
      Scalar.createApiReference('#app', {
        url: '${SPEC_PATH}',
        // Same origin as the page, so "Test Request" goes through this
        // server's proxy instead of hitting the API cross-origin.
        servers: [{ url: window.location.origin, description: 'ellamaka dev (proxied)' }]
      })
    </script>
  </body>
</html>`

serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url)
    const { pathname, search } = url

    // UI
    if (pathname === "/" || pathname === "/index.html") {
      return new Response(HTML, {
        headers: { "content-type": "text/html; charset=utf-8" },
      })
    }

    // OpenAPI spec, generated from source on startup
    if (pathname === SPEC_PATH) {
      return new Response(spec, {
        headers: {
          "content-type": "application/json",
          "access-control-allow-origin": "*",
        },
      })
    }

    // Proxy all other requests to ellamaka
    // Handle CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
          "access-control-allow-headers": "*",
        },
      })
    }

    const targetUrl = API_SERVER + pathname + search
    const resp = await fetch(targetUrl, {
      method: req.method,
      headers: req.headers,
      body: req.body,
    })
    const body = await resp.arrayBuffer()
    return new Response(body, {
      status: resp.status,
      headers: {
        "content-type": resp.headers.get("content-type") || "application/octet-stream",
        "access-control-allow-origin": "*",
        "access-control-expose-headers": "*",
      },
    })
  },
})

const page = `http://localhost:${PORT}`

if (OPEN_BROWSER) {
  const command =
    process.platform === "darwin"
      ? ["open", page]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", page]
        : ["xdg-open", page]
  try {
    Bun.spawn(command, { stdout: "ignore", stderr: "ignore" }).unref()
  } catch {
    // Headless environments simply skip the browser step.
  }
}

console.log(`
  ellamaka API Reference (Scalar)
  ─────────────────────────────────────
  UI:         ${page}
  Spec:       ${page}${SPEC_PATH}   (generated from source)
  API Server: ${API_SERVER}
  ─────────────────────────────────────
  Override: SCALAR_PORT=8080 SCALAR_API=http://host:port bun run scripts/scalar-doc.ts
  Headless: bun run scripts/scalar-doc.ts --no-open
`)
