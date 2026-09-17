import { $ } from "bun"
import { resolveDevSidecarChannel } from "./dev-channel"

await $`bun ./scripts/copy-icons.ts ${process.env.ELLAMAKA_CHANNEL ?? "dev"}`

process.env.ELLAMAKA_CHANNEL = resolveDevSidecarChannel()
try {
  await $`cd ../opencode && bun script/build-node.ts`
} catch {
  console.log("[predev] Skipping sidecar rebuild in worktree environment")
}
