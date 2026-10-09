import "@wopal/ellamaka-cordis/runtime/preload"
import { runBunPtcChildIfRequested } from "@wopal/ellamaka-cordis/runtime/bun-ptc-child"

if (!(await runBunPtcChildIfRequested())) {
  await import("./index")
}
