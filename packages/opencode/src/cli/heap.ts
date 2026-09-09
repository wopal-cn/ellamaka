import path from "path"
import { writeHeapSnapshot } from "node:v8"
import { Flag } from "@wopal/ellamaka-core/flag/flag"
import { Global } from "@wopal/ellamaka-core/global"
import * as Log from "@wopal/ellamaka-core/util/log"

const log = Log.create({ service: "heap" })
const MINUTE = 60_000
const LIMIT = 2 * 1024 * 1024 * 1024

let timer: Timer | undefined
let lock = false
let armed = true

export function start() {
  if (!Flag.OPENCODE_AUTO_HEAP_SNAPSHOT) return
  if (timer) return

  const run = async () => {
    if (lock) return

    const stat = process.memoryUsage()
    if (stat.rss <= LIMIT) {
      armed = true
      return
    }
    if (!armed) return

    lock = true
    armed = false
    const now = new Date()
    const pad = (n: number) => String(n).padStart(2, "0")
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${now.getDate()}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
    const file = path.join(
      Global.Path.log,
      `heap-${process.pid}-${stamp}.heapsnapshot`,
    )
    log.warn("heap usage exceeded limit", {
      rss: stat.rss,
      heap: stat.heapUsed,
      file,
    })

    await Promise.resolve()
      .then(() => writeHeapSnapshot(file))
      .catch((err) => {
        log.error("failed to write heap snapshot", {
          error: err instanceof Error ? err.message : String(err),
          file,
        })
      })

    lock = false
  }

  timer = setInterval(() => {
    void run()
  }, MINUTE)
  timer.unref?.()
}

export * as Heap from "./heap"
