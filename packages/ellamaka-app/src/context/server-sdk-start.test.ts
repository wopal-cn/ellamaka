import { expect, test } from "bun:test"
import { scheduleServerSdkEventStart } from "./server-sdk-start"

test("starts Global Events without a paint frame and suppresses a start after cleanup", () => {
  let callback: () => void = () => {}
  let cancelled = 0
  let starts = 0
  const cancel = scheduleServerSdkEventStart(async () => { starts += 1 }, (fn) => { callback = fn; return 1 }, () => { cancelled += 1 })
  callback()
  expect(starts).toBe(1)
  cancel()
  expect(cancelled).toBe(1)
})
