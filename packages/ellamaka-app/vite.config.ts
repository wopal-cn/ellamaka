import { sentryVitePlugin } from "@sentry/vite-plugin"
import { defineConfig } from "vite"
import desktopPlugin from "./vite"

const sentry =
  process.env.SENTRY_AUTH_TOKEN && process.env.SENTRY_ORG && process.env.SENTRY_PROJECT
    ? sentryVitePlugin({
        authToken: process.env.SENTRY_AUTH_TOKEN,
        org: process.env.SENTRY_ORG,
        project: process.env.SENTRY_PROJECT,
        telemetry: false,
        release: {
          name: process.env.SENTRY_RELEASE ?? process.env.VITE_SENTRY_RELEASE,
        },
        sourcemaps: {
          assets: "./dist/**",
          filesToDeleteAfterUpload: "./dist/**/*.map",
        },
      })
    : false

export default defineConfig({
  plugins: [desktopPlugin, sentry] as any,
  server: {
    host: "0.0.0.0",
    allowedHosts: true,
    port: 3000,
    // Dev-only: proxy the DSH mount onto the backend origin so the Workbench
    // iframe and the official rc.1 browser-auth cookie share one origin. The
    // cookie is SameSite=Strict, and a :3000 -> :4097 cross-site iframe would
    // never carry it after the token exchange. Desktop and production serve
    // the frontend and the mount from one origin and are unaffected.
    proxy: {
      "/dsh": {
        target: process.env.ELLAMAKA_DSH_PROXY_TARGET ?? "http://127.0.0.1:4097",
        changeOrigin: true,
        ws: true,
        // The dsh rc.1 Host/Origin trust fence compares the browser Origin
        // against the request Host (`isTrustedApiRequest`): changeOrigin
        // rewrites Host onto the backend but leaves Origin at the :3000 page
        // origin, so every /api call 403s and the surface hangs "connecting".
        // Rewrite Origin onto the target origin — from the fence's
        // single-origin point of view the proxy IS the serving origin, so
        // same-origin markers stay truthful after the rewrite.
        configure: (proxy) => {
          const target = process.env.ELLAMAKA_DSH_PROXY_TARGET ?? "http://127.0.0.1:4097"
          // The handler signature is (proxyReq, req, ...): the browser Origin
          // lives on the original request, the proxyReq is the outgoing
          // ClientRequest (its `headers` are not readable pre-send).
          const rewrite = (proxyReq: { setHeader(key: string, value: string): void }, req: { headers: Record<string, string | string[] | undefined> }) => {
            if (req.headers.origin) proxyReq.setHeader("origin", target)
          }
          proxy.on("proxyReq", rewrite)
          proxy.on("proxyReqWs", rewrite)
        },
      },
    },
  },
  build: {
    target: "esnext",
    sourcemap: true,
  },
})
