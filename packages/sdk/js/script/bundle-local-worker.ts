import path from "node:path"

const sdk = path.resolve(import.meta.dir, "..")
const entry = path.resolve(sdk, "../../opencode/src/sdk/local-worker.ts")
const output = path.join(sdk, "dist/local/worker.js")
const result = await Bun.build({
  entrypoints: [entry],
  outdir: path.dirname(output),
  naming: "worker.js",
  target: "node",
  format: "esm",
  minify: false,
  sourcemap: "none",
  external: ["node:*"],
  plugins: [
    {
      name: "prefer-jsonc-esm",
      setup(build) {
        build.onResolve({ filter: /^jsonc-parser$/ }, () => ({
          path: path.resolve(sdk, "../../../node_modules/jsonc-parser/lib/esm/main.js"),
        }))
      },
    },
  ],
})
if (!result.success) throw new AggregateError(result.logs, "failed to bundle local SDK Worker")
