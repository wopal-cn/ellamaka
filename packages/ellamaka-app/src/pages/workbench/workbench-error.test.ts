import { describe, it, expect, afterEach, beforeEach, mock, spyOn } from "bun:test"
import { reportWorkbenchError, WORKBENCH_ERROR_EVENT } from "./workbench-error"

describe("reportWorkbenchError", () => {
  let consoleErrorSpy: ReturnType<typeof spyOn>
  let toastCalls: Array<{ variant: string; title: string; description?: string }>

  beforeEach(() => {
    consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {})

    toastCalls = []
    mock.module("@wopal/ui/toast", () => ({
      showToast: (options: { variant: string; title: string; description?: string }) => {
        toastCalls.push(options)
      },
    }))
  })

  afterEach(() => {
    mock.restore()
  })

  it("logs sanitized message and calls showToast for Error", () => {
    reportWorkbenchError("rename session", new Error("Network error"))

    expect(consoleErrorSpy).toHaveBeenCalledTimes(1)
    const [prefix, message] = consoleErrorSpy.mock.calls[0] ?? []
    expect(String(prefix)).toContain("[workbench] rename session failed:")
    expect(message).toBe("Network error")

    expect(toastCalls).toHaveLength(1)
    const toastArg = toastCalls[0]
    expect(toastArg.variant).toBe("error")
    expect(toastArg.title).toBe("rename session")
    expect(toastArg.description).toBe("Network error")
  })

  it("includes statusCode in log when error has statusCode", () => {
    class StatusError extends Error {
      statusCode = 404
    }

    const err = new StatusError("Not Found")
    reportWorkbenchError("load session", err)

    expect(consoleErrorSpy).toHaveBeenCalledTimes(1)
    const [, , status] = consoleErrorSpy.mock.calls[0] ?? []
    expect(String(status)).toContain("status: 404")
  })

  it("does not call showToast when silent is true", () => {
    reportWorkbenchError("abort", new Error("Aborted"), { silent: true })

    expect(consoleErrorSpy).toHaveBeenCalledTimes(1)
    expect(toastCalls).toHaveLength(0)
  })

  it("handles non-Error values gracefully", () => {
    reportWorkbenchError("unknown op", "something went wrong")

    expect(consoleErrorSpy).toHaveBeenCalledTimes(1)
    const [, message] = consoleErrorSpy.mock.calls[0] ?? []
    expect(message).toBe("something went wrong")

    expect(toastCalls).toHaveLength(1)
    const toastArg = toastCalls[0]
    expect(toastArg.description).toBe("something went wrong")
  })

  it("handles null/undefined gracefully", () => {
    reportWorkbenchError("null op", null)

    expect(consoleErrorSpy).toHaveBeenCalledTimes(1)
    const [, message] = consoleErrorSpy.mock.calls[0] ?? []
    expect(message).toBe("null")

    expect(toastCalls).toHaveLength(1)
  })

  it("handles object with message property", () => {
    reportWorkbenchError("custom error", { message: "Custom fail" })

    expect(consoleErrorSpy).toHaveBeenCalledTimes(1)
    const [, message] = consoleErrorSpy.mock.calls[0] ?? []
    expect(message).toBe("Custom fail")
  })

  it("dispatches errors to an active Workbench host instead of showing a toast", () => {
    const received: Array<{ operation: string; message: string }> = []
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<{ operation: string; message: string }>).detail
      received.push(detail)
      event.preventDefault()
    }
    window.addEventListener(WORKBENCH_ERROR_EVENT, listener)

    reportWorkbenchError("load session tree", new Error("Network error"))

    window.removeEventListener(WORKBENCH_ERROR_EVENT, listener)
    expect(received).toEqual([{ operation: "load session tree", message: "Network error" }])
    expect(toastCalls).toHaveLength(0)
  })
})
