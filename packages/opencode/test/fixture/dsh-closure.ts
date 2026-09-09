/**
 * DSH test fixture: seed a complete closure under a temp `$WOPAL_HOME` so the
 * unified Runtime Manager's fast path hits and `createDshRuntimeApi` resolves
 * the six official `@deepseek-ai/*` modules from it.
 *
 * The closure mirrors what the real materialiser produces (DESIGN-dsh-poc
 * §3.4.5): `closures/<fingerprint>/` with `package.json`, `package-lock.json`,
 * `runtime-manifest.json` and a `node_modules/@deepseek-ai` tree. Instead of
 * running arborist against the network, the `@deepseek-ai` tree is a symlink to
 * the real installed packages under `@wopal/ellamaka-cordis`'s own
 * `node_modules` — the bridge's loader and profile resolution realpath the
 * anchor, so the full installed closure (including the store-hoisted plugin
 * tree the profile bundles need) stays reachable.
 */
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import {
  DEFAULT_DSH_RUNTIME_MANIFEST,
  resolveInstallAnchor,
} from "@wopal/ellamaka-cordis/runtime"

/** The real `@deepseek-ai/*` tree shipped with the cordis package. */
const CORDIS_DEEPSEEK_AI_DIR = join(
  dirname(require.resolve("@wopal/ellamaka-cordis/package.json")),
  "node_modules",
  "@deepseek-ai",
)

/**
 * A minimal valid npm lockfile v3 document — the runtime-lock shape the real
 * materialiser's Arborist produces. The runtime only checks presence + shape
 * (DESIGN-dsh-poc §3.4.3), so a v3 lockfile with a packages map suffices.
 */
function runtimeLock(manifest: { dependencies: Record<string, string> }): string {
  const packages: Record<string, { version: string }> = { "": { version: "0.0.0" } }
  for (const [name, version] of Object.entries(manifest.dependencies)) {
    packages[`node_modules/${name}`] = { version }
  }
  return JSON.stringify(
    { name: "ellamaka-dsh-closure", lockfileVersion: 3, requires: true, packages },
    null,
    2,
  )
}

/**
 * Seed a complete real closure for the default manifest's fingerprint under a
 * temp `wopalHome`. Returns the install anchor path.
 */
export function seedDshClosure(wopalHome: string): string {
  const manifest = DEFAULT_DSH_RUNTIME_MANIFEST
  const anchor = resolveInstallAnchor(wopalHome, manifest)
  const closureDir = join(wopalHome, "dsh", "closures", anchor.genId)
  const nodeModules = join(closureDir, "node_modules")
  mkdirSync(nodeModules, { recursive: true })
  symlinkSync(CORDIS_DEEPSEEK_AI_DIR, join(nodeModules, "@deepseek-ai"), "dir")
  writeFileSync(
    join(closureDir, "package.json"),
    JSON.stringify({ name: "ellamaka-dsh-closure", dependencies: manifest.dependencies }),
  )
  // The stored lock is the runtime lock (valid npm v3 shape), so the fast path
  // hits and no network reify is triggered.
  writeFileSync(join(closureDir, "package-lock.json"), runtimeLock(manifest))
  writeFileSync(join(closureDir, "runtime-manifest.json"), JSON.stringify(manifest))
  return anchor.path
}
