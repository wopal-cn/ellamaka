/** @jsx h */
import { beforeAll, describe, expect, mock, test } from "bun:test"
import { render } from "solid-js/web"
import h from "solid-js/h"

/**
 * The `done` step owns exactly one launch action, and the shared bottom nav bar
 * is the only place that renders it (DESIGN-onboarding.md §交互模型: the nav bar
 * calls a registered closure, never a DOM query). An inline duplicate button
 * inside the step body is therefore a contract violation: it gives the same
 * action two visual owners and forces the root to locate it by class name.
 */

let DoneStep: typeof import("./done").DoneStep

const navigateCalls: string[] = []
type CompleteResult =
  | { completed: true }
  | { status: "failed"; error: { code: string; message: string } }

const completeMock = mock(async (): Promise<CompleteResult> => ({ completed: true }))
const probeMock = mock(async () => ({ ready: true }))

beforeAll(async () => {
  mock.module("@solidjs/router", () => ({
    useNavigate: () => (to: string) => {
      navigateCalls.push(to)
    },
  }))
  mock.module("../onboarding-client-context", () => ({
    useOnboardingClient: () => ({
      probe: probeMock,
      complete: completeMock,
      executeStep: mock(async () => ({ status: "completed" as const })),
    }),
  }))
  DoneStep = (await import("./done")).DoneStep
})

describe("DoneStep launch action ownership", () => {
  test("renders no inline launch button for the root to query", () => {
    const host = document.createElement("div")
    document.body.appendChild(host)
    const dispose = render(() => <DoneStep onRegisterLaunch={() => {}} />, host)

    expect(host.querySelector(".ob-done-launch")).toBeNull()
    expect(host.querySelector(".ob-done-launch-button")).toBeNull()
    expect(host.querySelectorAll("button").length).toBe(1) // only the Star action

    dispose()
    host.remove()
  })

  test("registers the launch action so the nav bar can call it directly", async () => {
    const host = document.createElement("div")
    document.body.appendChild(host)
    let launch: (() => void) | null = null
    const dispose = render(
      () => (
        <DoneStep
          onRegisterLaunch={(fn) => {
            launch = fn
          }}
        />
      ),
      host,
    )

    expect(typeof launch).toBe("function")

    const callsBefore = completeMock.mock.calls.length
    launch!()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(completeMock.mock.calls.length).toBe(callsBefore + 1)
    expect(navigateCalls).toContain("/workbench")

    dispose()
    host.remove()
  })

  test("reports launching state so the nav bar can disable itself", async () => {
    const host = document.createElement("div")
    document.body.appendChild(host)
    const launchingStates: boolean[] = []
    let launch: (() => void) | null = null
    const dispose = render(
      () => (
        <DoneStep
          onLaunchingChange={(launching) => launchingStates.push(launching)}
          onRegisterLaunch={(fn) => {
            launch = fn
          }}
        />
      ),
      host,
    )

    launch!()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(launchingStates[0]).toBe(true)

    dispose()
    host.remove()
  })

  test("unregisters on unmount so a stale closure is never invoked", () => {
    const host = document.createElement("div")
    document.body.appendChild(host)
    const registered: ((() => void) | null)[] = []
    const dispose = render(
      () => (
        <DoneStep
          onRegisterLaunch={(fn) => {
            registered.push(fn)
          }}
        />
      ),
      host,
    )

    dispose()

    expect(registered[0]).toBeInstanceOf(Function)
    expect(registered[registered.length - 1]).toBeNull()

    host.remove()
  })
})

describe("DoneStep health gate rejection", () => {
  test("surfaces the refusal in place and stays on the page", async () => {
    completeMock.mockImplementationOnce(async () => ({
      status: "failed",
      error: { code: "ONBOARDING_HEALTH_GATE_FAILED", message: "ontology broken: missing assembly" },
    }))

    const host = document.createElement("div")
    document.body.appendChild(host)
    let launch: (() => void) | null = null
    const dispose = render(
      () => (
        <DoneStep
          onRegisterLaunch={(fn) => {
            launch = fn
          }}
        />
      ),
      host,
    )

    const navigationsBefore = navigateCalls.length
    launch!()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(navigateCalls.length).toBe(navigationsBefore)
    expect(host.textContent).toContain("完成门禁未通过")
    expect(host.textContent).toContain("ontology broken: missing assembly")

    dispose()
    host.remove()
  })
})
