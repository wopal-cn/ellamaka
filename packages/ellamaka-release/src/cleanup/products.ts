// packages/ellamaka-release/src/cleanup/products.ts
//
// Product differences for release cleanup, expressed as configuration.
// The product-agnostic cleanup kernel (src/cleanup/core.ts) reads this
// config to drive retention, withdrawal, and the restore strategy. All
// product-aware behavior (path resolution, alias mapping, ontology mirror
// prefix handling) lives here so the kernel and CLI stay product-agnostic.

import type { ReleaseChannel } from "../identity"
import type { ProductConfig } from "./types"

export const PRODUCTS: Record<"ellamaka-cli" | "ellamaka-desktop", ProductConfig> = {
  "ellamaka-cli": {
    product: "ellamaka-cli",
    channels: ["stable"],
    r2Root: "ellamaka",
    betaRoot: null,
    latestAlias: "ellamaka/latest",
    aliasNames: ["ellamaka/latest"],
    ontologyRestore: "alias",
    githubRepo: "wopal-cn/ellamaka",
    githubTagPrefix: "ellamaka-cli-v",
    // --- path resolution (R2) ---
    rootForChannel: () => "ellamaka",
    versionFromPath: (p) => {
      const m = p.match(/^ellamaka\/v(.+)$/)
      return m ? m[1]! : null
    },
    channelFromPath: () => "stable",
    pathForVersion: (version) => `ellamaka/v${version}`,
    latestPrefixForChannel: () => "ellamaka/latest",
    aliasKeyForChannel: () => "ellamaka/latest/manifest.json",
    channelForAlias: (alias) => (alias.includes("ellamaka/latest") ? "stable" : null),
    // --- ontology mirror ---
    // The ontology repo historically mirrored CLI releases with a bare
    // ellamaka-v* prefix (e.g. ellamaka-v2.0.0); since the naming switch to
    // ellamaka-cli-v*, both prefixes can appear.
    githubOntologySelect: 'test("^ellamaka-(cli-)?v")',
    isOntologyTag: (t) =>
      (t.startsWith("ellamaka-cli-v") || t.startsWith("ellamaka-v")) && !t.startsWith("ellamaka-desktop-v"),
    ontologyVersion: (tag) =>
      tag.startsWith("ellamaka-cli-v") ? tag.slice("ellamaka-cli-v".length) : tag.slice("ellamaka-v".length),
  },
  "ellamaka-desktop": {
    product: "ellamaka-desktop",
    channels: ["stable", "beta"],
    r2Root: "ellamaka-desktop",
    betaRoot: "ellamaka-desktop/beta",
    latestAlias: "ellamaka-desktop/latest",
    aliasNames: ["ellamaka-desktop/latest", "ellamaka-desktop/beta/latest"],
    ontologyRestore: "latest-channel",
    githubRepo: "wopal-cn/ellamaka",
    githubTagPrefix: "ellamaka-desktop-v",
    // --- path resolution (R2) ---
    rootForChannel: (channel) => (channel === "beta" ? "ellamaka-desktop/beta" : "ellamaka-desktop"),
    versionFromPath: (p) => {
      const m = p.match(/^ellamaka-desktop\/(?:beta\/)?v(.+)$/)
      return m ? m[1]! : null
    },
    channelFromPath: (p) => (p.includes("/beta/") ? "beta" : "stable"),
    pathForVersion: (version, channel) =>
      channel === "beta" ? `ellamaka-desktop/beta/v${version}` : `ellamaka-desktop/v${version}`,
    latestPrefixForChannel: (channel) =>
      channel === "beta" ? "ellamaka-desktop/beta/latest" : "ellamaka-desktop/latest",
    aliasKeyForChannel: (channel) =>
      channel === "beta" ? "ellamaka-desktop/beta/latest/manifest.json" : "ellamaka-desktop/latest/manifest.json",
    channelForAlias: (alias) =>
      alias.includes("/beta/") ? "beta" : alias.includes("ellamaka-desktop") ? "stable" : null,
    // --- ontology mirror ---
    githubOntologySelect: 'test("^ellamaka-desktop-v")',
    isOntologyTag: (t) => t.startsWith("ellamaka-desktop-v"),
    ontologyVersion: (tag) => tag.slice("ellamaka-desktop-v".length),
  },
}

export type { ProductConfig }
export type { ReleaseChannel }
