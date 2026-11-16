import "@wopal/ellamaka-cordis/runtime/preload"
import { runBunSubprocessChildIfRequested } from "@wopal/ellamaka-cordis/runtime/bun-subprocess-child"

if (!(await runBunSubprocessChildIfRequested())) await import("./index")
