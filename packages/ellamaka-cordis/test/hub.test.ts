import { describe, expect, test } from "bun:test"
import { Context as CordisContext, Service } from "@deepseek-ai/cordis"
import { CordisHub } from "../src/hub"

// --- Test fixtures: cordis services/plugins shared across cases ---

declare module "@deepseek-ai/cordis" {
  interface Context {
    greet: GreetService
  }
}

class GreetService extends Service {
  static provide = "greet"
  constructor(ctx: CordisContext, public msg: string) {
    super(ctx, "greet")
  }
  greet() {
    return this.msg
  }
}

class GreetPlugin extends Service {
  static name = "greet-plugin"
  static inject = ["greet"]
  constructor(ctx: CordisContext) {
    super(ctx, "greet-plugin")
  }
}

// --- 1. Container mount / unmount ---

describe("CordisHub container lifecycle", () => {
  test("mounts a plugin and exposes its provided service on ctx", async () => {
    const hub = new CordisHub(null)
    await hub.mount(GreetService, "hello from cordis")
    await hub.mount(GreetPlugin)
    expect(hub.ctx.greet.greet()).toBe("hello from cordis")
    await hub.dispose()
  })
})

// --- 2. Service registration (duplicate detection) ---

describe("CordisHub service registration", () => {
  class DupA extends Service {
    static provide = "dupX"
    constructor(ctx: CordisContext) {
      super(ctx, "dupX")
    }
  }
  class DupB extends Service {
    static provide = "dupX"
    constructor(ctx: CordisContext) {
      super(ctx, "dupX")
    }
  }

  test("throws a cordis duplicate-service error when registering the same name twice", async () => {
    const hub = new CordisHub(null)
    await hub.mount(DupA)
    let error: unknown
    try {
      await hub.mount(DupB)
    } catch (e) {
      error = e
    }
    expect(error).toBeDefined()
    expect(String(error)).toMatch(/service "dupX" has been registered/)
    await hub.dispose()
  })
})

// --- 3. Event dispatch ---

describe("CordisHub event dispatch", () => {
  test("ctx.emit delivers the payload to listeners", async () => {
    const hub = new CordisHub(null)
    const received: unknown[] = []
    hub.ctx.on("evt", (payload: unknown) => {
      received.push(payload)
    })
    hub.ctx.emit("evt", { id: 42 })
    expect(received).toEqual([{ id: 42 }])
    await hub.dispose()
  })
})

// --- 4. dispose cleanup ---

describe("CordisHub dispose", () => {
  test("dispose awaits ctx.fiber.dispose and is idempotent", async () => {
    const hub = new CordisHub(null)
    let disposed = false
    const origDispose = hub.ctx.fiber.dispose.bind(hub.ctx.fiber)
    ;(hub.ctx.fiber as unknown as { dispose: typeof origDispose }).dispose = async () => {
      disposed = true
      return origDispose()
    }
    await hub.dispose()
    expect(disposed).toBe(true)
    // A second dispose is safe (idempotent).
    await hub.dispose()
    expect(disposed).toBe(true)
  })
})
