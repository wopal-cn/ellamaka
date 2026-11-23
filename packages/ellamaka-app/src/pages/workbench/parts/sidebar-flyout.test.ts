import { describe, expect, test } from "bun:test"
import {
  createFlyoutController,
  flyoutVisibilityClass,
  FLYOUT_HIDE_DELAY_MS,
  FLYOUT_CLICK_CLOSE_DELAY_MS,
} from "./sidebar-flyout"

// Deferred-timer harness shared by the delay-behavior tests.
function createTimedFlyout(input: { pinned?: () => boolean } = {}) {
  const pending = new Map<ReturnType<typeof setTimeout>, () => void>()
  const flyout = createFlyoutController({
    pinned: input.pinned ?? (() => false),
    setTimeoutFn: ((fn: () => void, ms: number) => {
      const id = {} as unknown as ReturnType<typeof setTimeout>
      pending.set(id, () => fn())
      void ms
      return id
    }) as typeof setTimeout,
    clearTimeoutFn: ((id: ReturnType<typeof setTimeout>) => {
      pending.delete(id)
    }) as typeof clearTimeout,
  })
  return {
    flyout,
    flush: () => {
      for (const fn of [...pending.values()]) fn()
    },
    pending,
  }
}

describe("flyoutVisibilityClass", () => {
  test("closed state hides via CSS visibility so the tree stays mounted", () => {
    const cls = flyoutVisibilityClass(false)
    expect(cls).toContain("invisible")
    expect(cls).toContain("pointer-events-none")
  })

  test("open state is fully visible", () => {
    const cls = flyoutVisibilityClass(true)
    expect(cls).not.toContain("invisible")
    expect(cls).not.toContain("pointer-events-none")
  })
})

describe("sidebar hover flyout", () => {
  test("opens on trigger hover when the rail is collapsed", () => {
    const flyout = createFlyoutController({ pinned: () => false })
    expect(flyout.isOpen()).toBe(false)
    flyout.onTriggerEnter("sessions")
    expect(flyout.isOpen()).toBe(true)
  })

  test("does not open on hover while the rail is pinned open", () => {
    const flyout = createFlyoutController({ pinned: () => true })
    flyout.onTriggerEnter("sessions")
    expect(flyout.isOpen()).toBe(false)
  })

  test("stays open when the pointer moves from the trigger into the flyout", () => {
    let now = 0
    const timers = new Map<ReturnType<typeof setTimeout>, () => void>()
    const flyout = createFlyoutController({
      pinned: () => false,
      setTimeoutFn: ((fn: () => void, _ms: number) => {
        const id = { fn } as unknown as ReturnType<typeof setTimeout>
        timers.set(id, fn)
        return id
      }) as typeof setTimeout,
      clearTimeoutFn: ((id: ReturnType<typeof setTimeout>) => {
        timers.delete(id)
      }) as typeof clearTimeout,
    })

    flyout.onTriggerEnter("sessions")
    flyout.onTriggerLeave()
    expect(timers.size).toBe(1)
    flyout.onFlyoutEnter()
    expect(timers.size).toBe(0)
    expect(flyout.isOpen()).toBe(true)
    void now
  })

  test("hides after the delay once the pointer leaves both trigger and flyout", () => {
    const pending: Array<() => void> = []
    const flyout = createFlyoutController({
      pinned: () => false,
      setTimeoutFn: ((fn: () => void, ms: number) => {
        expect(ms).toBe(FLYOUT_HIDE_DELAY_MS)
        pending.push(fn)
        return pending.length as unknown as ReturnType<typeof setTimeout>
      }) as typeof setTimeout,
      clearTimeoutFn: (() => {}) as typeof clearTimeout,
    })

    flyout.onTriggerEnter("sessions")
    flyout.onTriggerLeave()
    expect(flyout.isOpen()).toBe(true)
    pending.forEach((fn) => fn())
    expect(flyout.isOpen()).toBe(false)
  })

  test("close() hides immediately and cancels a pending hide", () => {
    const pending: Array<() => void> = []
    const flyout = createFlyoutController({
      pinned: () => false,
      setTimeoutFn: ((fn: () => void) => {
        pending.push(fn)
        return pending.length as unknown as ReturnType<typeof setTimeout>
      }) as typeof setTimeout,
      clearTimeoutFn: (() => {
        pending.length = 0
      }) as typeof clearTimeout,
    })

    flyout.onTriggerEnter("sessions")
    flyout.close()
    expect(flyout.isOpen()).toBe(false)
    expect(pending.length).toBe(0)
  })

  test("isOpen() reports closed once the rail becomes pinned even if open was requested", () => {
    let pinned = false
    const flyout = createFlyoutController({ pinned: () => pinned })
    flyout.onTriggerEnter("sessions")
    expect(flyout.isOpen()).toBe(true)
    pinned = true
    expect(flyout.isOpen()).toBe(false)
  })

  test("reports the mode of the last hovered trigger", () => {
    const flyout = createFlyoutController({ pinned: () => false })
    expect(flyout.mode()).toBe("sessions")
    flyout.onTriggerEnter("files")
    expect(flyout.mode()).toBe("files")
    expect(flyout.isOpen()).toBe(true)
  })

  test("switching mode while open notifies onChange with the new mode", () => {
    const seen: Array<"sessions" | "files"> = []
    const flyout = createFlyoutController({
      pinned: () => false,
      onChange: (mode) => seen.push(mode),
    })
    flyout.onTriggerEnter("sessions")
    flyout.onTriggerEnter("files")
    expect(seen).toEqual(["sessions", "files"])
    expect(flyout.mode()).toBe("files")
  })

  test("hovering the same mode again does not re-notify", () => {
    const seen: Array<"sessions" | "files"> = []
    const flyout = createFlyoutController({
      pinned: () => false,
      onChange: (mode) => seen.push(mode),
    })
    flyout.onTriggerEnter("sessions")
    flyout.onTriggerLeave()
    flyout.onTriggerEnter("sessions")
    expect(seen).toEqual(["sessions"])
  })

  test("files flyout stays suppressed while the rail is pinned", () => {
    const flyout = createFlyoutController({ pinned: () => true })
    flyout.onTriggerEnter("files")
    expect(flyout.isOpen()).toBe(false)
  })

  test("closeSoon schedules a delayed close instead of hiding immediately", () => {
    const { flyout, flush } = createTimedFlyout()
    flyout.onTriggerEnter("sessions")
    expect(flyout.isOpen()).toBe(true)
    flyout.closeSoon()
    // A double-click's second click must still find the flyout open.
    expect(flyout.isOpen()).toBe(true)
    flush()
    expect(flyout.isOpen()).toBe(false)
  })

  test("closeSoon delays by the double-click-safe duration", () => {
    const delays: number[] = []
    const flyout = createFlyoutController({
      pinned: () => false,
      setTimeoutFn: ((fn: () => void, ms: number) => {
        delays.push(ms)
        return 1 as unknown as ReturnType<typeof setTimeout>
      }) as typeof setTimeout,
    })
    flyout.onTriggerEnter("sessions")
    flyout.closeSoon()
    expect(delays).toContain(FLYOUT_CLICK_CLOSE_DELAY_MS)
    expect(FLYOUT_CLICK_CLOSE_DELAY_MS).toBeGreaterThan(300)
  })

  test("requestClose hides immediately even with a pending closeSoon", () => {
    const { flyout } = createTimedFlyout()
    flyout.onTriggerEnter("sessions")
    flyout.closeSoon()
    expect(flyout.isOpen()).toBe(true)
    flyout.requestClose()
    expect(flyout.isOpen()).toBe(false)
  })

  test("a trigger re-enter after closeSoon keeps the flyout open past the timer", () => {
    const { flyout, flush } = createTimedFlyout()
    flyout.onTriggerEnter("sessions")
    flyout.closeSoon()
    // The pointer moved back over the trigger before the delayed close fired.
    flyout.onTriggerEnter("sessions")
    flush()
    expect(flyout.isOpen()).toBe(true)
  })
})
