#!/usr/bin/env bun
import { $ } from "bun"
import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { resolveChannel } from "./utils"

import { resolve } from "node:path"

const channel = resolveChannel()
await $`bun ./scripts/copy-icons.ts ${channel}`
await $`bun ./scripts/copy-metainfo.ts ${channel}`

// Generate / verify the DSH runtime manifest BEFORE building the sidecar:
// `script/build-node.ts` bundles `src/node.ts` → `@wopal/ellamaka-cordis/runtime`
// → `embed-manifest.ts`, whose static JSON import inlines
// `generated/dsh-runtime-manifest.json` into the sidecar bundle. Running the
// generator here guarantees the packaged sidecar carries a manifest that
// matches the source at build time. Release channels (beta/prod) only verify
// (`--check`, read-only); the local `main` channel regenerates when the
// committed manifest is missing or dirty.
const resourcesDir = resolve(import.meta.dir, "..", "resources")
const dshManifestSrc = resolve(import.meta.dir, "..", "..", "ellamaka-cordis", "generated", "dsh-runtime-manifest.json")
const dshManifestOut = join(resourcesDir, "dsh-runtime-manifest.json")
const dshManifestGenerator = resolve(import.meta.dir, "..", "..", "ellamaka-cordis", "script", "generate-dsh-runtime-manifest.ts")

if (channel === "main") {
  const generate = async () => {
    console.log("[prebuild] generating DSH runtime manifest")
    await $`bun ${dshManifestGenerator}`
  }
  if (!existsSync(dshManifestSrc)) {
    await generate()
  } else {
    try {
      await $`bun ${dshManifestGenerator} --check`
    } catch {
      console.warn("[prebuild] DSH runtime manifest is out of date — regenerating for local build")
      await generate()
    }
  }
} else {
  console.log("[prebuild] verifying DSH runtime manifest (--check)")
  await $`bun ${dshManifestGenerator} --check`
}

// Copy the manifest into the resources injection dir (mirroring the
// release-identity pattern) so the packaged bundle carries a readable copy.
writeFileSync(dshManifestOut, await Bun.file(dshManifestSrc).text())
console.log(`[prebuild] wrote ${dshManifestOut}`)

await $`cd ../opencode && bun script/build-node.ts`

// Generate resources/release-identity.json. Per docs/DISTRIBUTION.md §5.4,
// Desktop packages embed the same release context that produced the build.
// For local dev builds (channel "main"), a development identity is written;
// for beta/prod, a release-context.json (if provided via env) is the source.
await writeEmbeddedReleaseIdentity(channel)

async function writeEmbeddedReleaseIdentity(channel: "main" | "beta" | "prod") {
  const outPath = join(resourcesDir, "release-identity.json")
  const ctxPath = process.env.ELLAMAKA_RELEASE_CONTEXT_PATH

  let identity: Record<string, unknown>
  if ((channel === "beta" || channel === "prod") && ctxPath) {
    const ctx = JSON.parse(await Bun.file(ctxPath).text())
    identity = {
      schemaVersion: 2,
      kind: "release",
      product: "ellamaka-desktop",
      version: ctx.version,
      channel: ctx.channel,
      upstream: ctx.upstream,
      build: ctx.build,
    }
  } else {
    const version = process.env.OPENCODE_VERSION?.trim() || "0.0.0-dev"
    identity = {
      schemaVersion: 2,
      kind: "development",
      product: "ellamaka-desktop",
      version,
      channel: channel === "main" ? "main" : "local",
      build: {
        ...(process.env.OPENCODE_BUILD_ID && /^[0-9a-f]{40}$/.test(process.env.OPENCODE_BUILD_ID)
          ? { gitCommit: process.env.OPENCODE_BUILD_ID }
          : {}),
        builtAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      },
    }
  }
  writeFileSync(outPath, JSON.stringify(identity, null, 2) + "\n")
  console.log(`[prebuild] wrote ${outPath}`)
}
