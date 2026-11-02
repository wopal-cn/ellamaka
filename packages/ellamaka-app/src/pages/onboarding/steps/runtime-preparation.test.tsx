/** @jsx h */
import { expect, test } from "bun:test"
import { render } from "solid-js/web"
import h from "solid-js/h"
import { RuntimePreparationView } from "./runtime-preparation"

test("shows the real phase and ignores a late preparation failure after leaving", async () => {
  let rejectPreparation!: (error: Error) => void
  const pending = new Promise<{ status: "ready" }>((_, reject) => (rejectPreparation = reject))
  const messages: string[] = []
  const failures: string[] = []
  let ready = false
  const host = document.createElement("div")
  document.body.appendChild(host)
  const dispose = render(
    () => (
      <RuntimePreparationView
        prepare={() => pending}
        health={async () => ({
          healthy: true,
          preparation: {
            state: "PREPARING",
            steps: [{ step: "dsh.closure", state: "NEEDS_PREPARATION" }],
            run: { step: "dsh.closure", phase: "materialize", elapsedMs: 5000 },
          },
        })}
        onProgress={(message) => messages.push(message)}
        onFailed={(message) => failures.push(message)}
        onReady={() => (ready = true)}
      />
    ),
    host,
  )
  await Promise.resolve()
  expect(host.textContent).toContain("下载并安装依赖")
  expect(messages.some((message) => message.includes("下载并安装依赖"))).toBe(true)
  dispose()
  const count = messages.length
  rejectPreparation(new Error("late failure"))
  await pending.catch(() => {})
  await Promise.resolve()
  expect(failures).toEqual([])
  expect(messages).toHaveLength(count)
  expect(ready).toBe(false)
  host.remove()
})
