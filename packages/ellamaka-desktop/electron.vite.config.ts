import { sentryVitePlugin } from "@sentry/vite-plugin"
import { defineConfig } from "electron-vite"
import appPlugin from "@wopal/ellamaka-app/vite"
import { resolveBuildChannel } from "@wopal/ellamaka-release/channel-resolve"
import * as fs from "node:fs/promises"
import * as fsSync from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const OPENCODE_SERVER_DIST = "../opencode/dist/node"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const channel = resolveBuildChannel(process.env.ELLAMAKA_CHANNEL, "local")

const nodePtyPkg = `@lydell/node-pty-${process.platform}-${process.arch}`

// `@wopal/ellamaka-core` exports TypeScript sources (`"./*": "./src/*.ts"`). A
// packaged Electron main process cannot rely on runtime type stripping and
// electron-builder must not have to ship the workspace package, so the main
// bundle inlines it. Every other dependency keeps the default externalization.
const BUNDLED_SOURCE_DEPS = ["@wopal/ellamaka-core"] as const
const dshProxyTarget =
  process.env.ELLAMAKA_DSH_PROXY_TARGET ?? `http://127.0.0.1:${process.env.ELLAMAKA_PORT ?? "4097"}`

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

// `virtual:opencode-server` resolves to the prebuilt sidecar bundle, which the
// main build then bundles a second time. Rollup is analysing a finished
// artifact, so its findings there are noise rather than anything the desktop
// can fix:
//
//   UNUSED_EXTERNAL_IMPORT  the symbols are used; the dist re-exports them
//                           through paths Rollup does not follow
//   EVAL                    protobufjs/inquire, gray-matter and the emscripten
//                           glue all reach for `eval` inside their own
//                           implementation; forking upstream is the only fix,
//                           and the sidecar runs locally on already-trusted code
//
// Suppress only these, and only for that one artifact, so a real problem in a
// desktop source file still prints. The list is deliberately narrow: a blanket
// `onwarn` would hide the warnings this narrowing exists to surface.
const SIDECAR_DIST_FILE = path.resolve(__dirname, OPENCODE_SERVER_DIST, "node.js")
const SIDECAR_DIST_NOISE = new Set(["UNUSED_EXTERNAL_IMPORT", "EVAL"])
function onwarn(warning, defaultHandler) {
  // `EVAL` carries the artifact in `id`; `UNUSED_EXTERNAL_IMPORT` carries it in
  // `ids` with `id` left undefined.
  const files = warning.id ? [warning.id] : (warning.ids ?? [])
  const onlySidecarDist =
    SIDECAR_DIST_NOISE.has(warning.code) && files.length > 0 && files.every((file) => file === SIDECAR_DIST_FILE)
  if (!onlySidecarDist) defaultHandler(warning)
}

export default defineConfig({
  main: {
    define: {
      "import.meta.env.ELLAMAKA_CHANNEL": JSON.stringify(channel),
    },
    build: {
      // Rollup reports every one of these across two passes; only the desktop's
      // own sources matter here, so drop the sidecar artifact's findings.
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
        onwarn,
      },
      externalizeDeps: { include: [nodePtyPkg], exclude: [...BUNDLED_SOURCE_DEPS] },
    },
    plugins: [
      {
        name: "opencode:node-pty-narrower",
        enforce: "pre",
        resolveId(s) {
          if (s === "@lydell/node-pty") return nodePtyPkg
          return null
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
          return null
        },
        load(id) {
          if (id === "\0virtual:opencode-server") {
            return "export default {}; export const Server = {};"
          }
          return null
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
    // Mirrors `ellamaka-app/vite.config.ts`. Files carrying a
    // `@jsxImportSource` pragma (the workbench status-bar diagnostics module
    // and virtua's solid entry) are compiled by vite-plugin-solid, but Vite's
    // built-in esbuild pass still inspects them with the tsconfig
    // `jsx: "preserve"` + `jsxImportSource` pair. esbuild rejects that
    // combination with a spurious "React automatic transform" warning.
    // Declaring the automatic transform here settles the esbuild pass; it does
    // not alter output because .tsx/.jsx are handed to Solid's babel pipeline
    // regardless.
    esbuild: { jsx: "automatic" },
    build: {
      sourcemap: true,
      rollupOptions: {
        input: {
          main: "src/renderer/index.html",
          loading: "src/renderer/loading.html",
        },
        output: {
          // Mirrors `ellamaka-app/vite.config.ts`. The oniguruma wasm binary
          // (vscode-oniguruma, used by shiki) and the "wasm" language grammar
          // (a shiki bundled TextMate grammar) both land in chunks Rollup names
          // "wasm", colliding their sourcemap filenames. Give the binary its
          // own chunk name. The descriptor match keeps the SolidJS vendor chunk
          // from drifting back into the entry bundle.
          manualChunks(id) {
            if (id.includes("oniguruma")) return "onig-wasm"
            if (
              id.includes("node_modules/solid-js") ||
              id.includes("node_modules/@solidjs") ||
              id.includes("node_modules/@solid-primitives") ||
              id.includes("node_modules/@kobalte")
            )
              return "solid-vendor"
            return undefined
          },
        },
      },
    },
  },
})
