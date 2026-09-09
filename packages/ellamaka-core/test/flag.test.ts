import { afterEach, describe, expect, test } from "bun:test"
import { Flag } from "@wopal/ellamaka-core/flag/flag"

// ELLAMAKA_DSH is a kill switch, default ON (DESIGN-dsh-poc §3.4, constraint
// #11). `ELLAMAKA_DSH=0` disables dsh; unset or any non-"0" value enables it.
describe("ELLAMAKA_DSH kill switch", () => {
  afterEach(() => {
    delete process.env.ELLAMAKA_DSH
  })

  test("enabled when ELLAMAKA_DSH is unset (default on)", () => {
    delete process.env.ELLAMAKA_DSH
    expect(Flag.ELLAMAKA_DSH).toBe(true)
  })

  test("disabled when ELLAMAKA_DSH=0", () => {
    process.env.ELLAMAKA_DSH = "0"
    expect(Flag.ELLAMAKA_DSH).toBe(false)
  })

  test("enabled when ELLAMAKA_DSH=1", () => {
    process.env.ELLAMAKA_DSH = "1"
    expect(Flag.ELLAMAKA_DSH).toBe(true)
  })

  test("enabled when ELLAMAKA_DSH is any non-zero value", () => {
    process.env.ELLAMAKA_DSH = "true"
    expect(Flag.ELLAMAKA_DSH).toBe(true)
  })

  test("evaluated at access time, not module load", () => {
    delete process.env.ELLAMAKA_DSH
    expect(Flag.ELLAMAKA_DSH).toBe(true)
    process.env.ELLAMAKA_DSH = "0"
    expect(Flag.ELLAMAKA_DSH).toBe(false)
  })
})
