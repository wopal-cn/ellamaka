import { runWebChildIfRequested } from "../../src/runtime/web-child"

if (!(await runWebChildIfRequested(process.argv))) {
  throw new Error("ellamaka-cordis: web child entry invoked without a valid child request")
}
