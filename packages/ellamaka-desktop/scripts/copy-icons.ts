import { $ } from "bun"
import { resolveBuildChannel } from "@wopal/ellamaka-release/channel-resolve"
import { resolveChannel } from "./utils"

// An explicit argument must be in the closed build-channel vocabulary
// {stable, beta, main, local}: out-of-vocabulary values — including the legacy
// "dev" — fail loudly instead of silently folding. No argument → resolve from
// ELLAMAKA_CHANNEL / default, as before.
const arg = process.argv[2]
const channel = arg === undefined ? resolveChannel() : resolveBuildChannel(arg)

// There is no dedicated local icon set: local is a dev channel and shares the
// main assets, mirroring electron-builder.config.ts where local packs with the
// main app identity. The projection is explicit so no channel folds silently.
const iconSet = channel === "local" ? "main" : channel

const src = `./icons/${iconSet}`
const dest = "resources/icons"

await $`rm -rf ${dest}`
await $`cp -R ${src} ${dest}`
console.log(`Copied ${iconSet} icons (channel: ${channel}) from ${src} to ${dest}`)
