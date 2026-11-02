import { expect, test } from "bun:test"
import { createDshStageGate } from "@/workbench/dsh-mount-registry"

test("refuses activation before setup and joins activation after completion", async () => {
  let calls = 0
  const gate = createDshStageGate(async () => {
    calls++
    return true
  }, false)
  expect(await gate.ensure()).toBe(false)
  expect(calls).toBe(0)
  gate.completeSetup()
  expect(await Promise.all([gate.ensure(), gate.ensure()])).toEqual([true, true])
  expect(calls).toBe(1)
})

test("a completed startup admits activation", async () => {
  let calls = 0
  const gate = createDshStageGate(async () => {
    calls++
    return true
  }, true)
  expect(await gate.ensure()).toBe(true)
  expect(calls).toBe(1)
})
