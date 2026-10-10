import { runBunPtcChildIfRequested } from "./bun-ptc-child.js"

if (!(await runBunPtcChildIfRequested())) {
  throw new Error("ellamaka-cordis: Bun PTC child entry invoked without a valid child request")
}
