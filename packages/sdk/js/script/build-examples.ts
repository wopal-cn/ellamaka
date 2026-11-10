import { readdirSync } from "node:fs"
import path from "node:path"

// A plain `tsc` would also emit the library sources the examples import, into
// `dist/src/`, which breaks the shipped layout. Bundle each example and keep
// the SDK external so Node resolves "@wopal/ellamaka-sdk/..." via `exports`.
const sdk = path.resolve(import.meta.dir, "..")
const examples = path.join(sdk, "examples")
const entrypoints = readdirSync(examples)
  .filter((file) => file.endsWith(".ts"))
  .map((file) => path.join(examples, file))
if (entrypoints.length === 0) throw new Error("no SDK examples to build")

const result = await Bun.build({
  entrypoints,
  outdir: path.join(sdk, "dist", "examples"),
  target: "node",
  format: "esm",
  minify: false,
  sourcemap: "none",
  external: ["@wopal/ellamaka-sdk", "@wopal/ellamaka-sdk/*"],
})
if (!result.success) throw new AggregateError(result.logs, "failed to build the SDK examples")
