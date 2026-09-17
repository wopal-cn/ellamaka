import { $ } from "bun"
import { resolveBuildChannel } from "@wopal/ellamaka-release/channel-resolve"
import { resolveDevSidecarChannel } from "./dev-channel"

// Closed vocabulary only: an unset channel falls back to "local" (not the
// legacy "dev"), and an out-of-vocabulary value folds to "local" rather than
// leaking a non-vocabulary channel into the dev build chain.
const channel = resolveBuildChannel(process.env.ELLAMAKA_CHANNEL, "local")

await $`bun ./scripts/copy-icons.ts ${channel}`

process.env.ELLAMAKA_CHANNEL = resolveDevSidecarChannel()
try {
  await $`cd ../opencode && bun script/build-node.ts`
} catch {
  console.log("[predev] Skipping sidecar rebuild in worktree environment")
}
