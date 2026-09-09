import { sentryVitePlugin } from "@sentry/vite-plugin"
import { defineConfig } from "electron-vite"
import appPlugin from "@wopal/ellamaka-app/vite"
import * as fs from "node:fs/promises"
import * as fsSync from "node:fs"

const OPENCODE_SERVER_DIST = "../opencode/dist/node"

const channel = (() => {
  const raw = process.env.OPENCODE_CHANNEL
  if (raw === "local" || raw === "main" || raw === "beta" || raw === "prod") return raw
  if (process.env.OPENCODE_CHANNEL === "latest") return "prod"
  return "local"
})()

const nodePtyPkg = `@lydell/node-pty-${process.platform}-${process.arch}`
const dshProxyTarget = process.env.ELLAMAKA_DSH_PROXY_TARGET ?? `http://127.0.0.1:${process.env.OPENCODE_PORT ?? "4097"}`

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
          assets: "./out/renderer/**",
          filesToDeleteAfterUpload: "./out/renderer/**/*.map",
        },
      })
    : false

export default defineConfig({
  main: {
    define: {
      "import.meta.env.OPENCODE_CHANNEL": JSON.stringify(channel),
      "import.meta.env.MIN_WOPAL_CLI_VERSION": JSON.stringify(process.env.MIN_WOPAL_CLI_VERSION || "0.3.13"),
    },
    build: {
      rollupOptions: {
        input: {
          index: "src/main/index.ts",
          sidecar: "src/main/sidecar.ts",
          "source-ts-loader": "src/main/source-ts-loader.ts",
        },
        // kerberos is an optional peer of proxy-agent-negotiate (pulled in by the
        // npm bootstrap deps bundled in the opencode server dist); it is loaded
        // lazily at runtime with a graceful fallback, so keep it external.
        external: ["kerberos"],
      },
      externalizeDeps: { include: [nodePtyPkg] },
    },
    plugins: [
      {
        name: "opencode:node-pty-narrower",
        enforce: "pre",
        resolveId(s) {
          if (s === "@lydell/node-pty") return nodePtyPkg
        },
      },
      {
        name: "opencode:virtual-server-module",
        enforce: "pre",
        resolveId(id) {
          if (id === "virtual:opencode-server") {
            const target = `${OPENCODE_SERVER_DIST}/node.js`
            if (fsSync.existsSync(target)) {
              return this.resolve(target)
            }
            return "\0virtual:opencode-server"
          }
        },
        load(id) {
          if (id === "\0virtual:opencode-server") {
            return "export default {}; export const Server = {};"
          }
        },
      },
      {
        name: "opencode:copy-server-assets",
        async writeBundle() {
          if (!fsSync.existsSync(OPENCODE_SERVER_DIST)) return
          for (const l of await fs.readdir(OPENCODE_SERVER_DIST)) {
            if (!l.endsWith(".wasm")) continue
            await fs.writeFile(`./out/main/chunks/${l}`, await fs.readFile(`${OPENCODE_SERVER_DIST}/${l}`))
          }
        },
      },
    ],
  },
  preload: {
    build: {
      rollupOptions: {
        input: { index: "src/preload/index.ts" },
        output: {
          format: "cjs",
          entryFileNames: "[name].js",
        },
      },
    },
  },
  renderer: {
    plugins: [appPlugin, sentry],
    server: {
      proxy: {
        "/dsh": {
          target: dshProxyTarget,
          changeOrigin: true,
          ws: true,
          configure: (proxy) => {
            const rewrite = (
              proxyReq: { setHeader(key: string, value: string): void },
              req: { headers: Record<string, string | string[] | undefined> },
            ) => {
              if (req.headers.origin) proxyReq.setHeader("origin", dshProxyTarget)
            }
            proxy.on("proxyReq", rewrite)
            proxy.on("proxyReqWs", rewrite)
          },
        },
      },
    },
    publicDir: "../../../ellamaka-app/public",
    root: "src/renderer",
    build: {
      sourcemap: true,
      rollupOptions: {
        input: {
          main: "src/renderer/index.html",
          loading: "src/renderer/loading.html",
        },
      },
    },
  },
})
