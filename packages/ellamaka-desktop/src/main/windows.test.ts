import { describe, expect, test } from "bun:test"
import { wireZoom } from "./windows"

type WebContentsHandler = (...args: unknown[]) => void

function makeFakeWindow() {
  const handlers = new Map<string, WebContentsHandler>()
  const sent: Array<[string, unknown]> = []
  let zoomFactor = 1
  const webContents = {
    setZoomFactor: (factor: number) => {
      zoomFactor = factor
    },
    getZoomFactor: () => zoomFactor,
    on: (event: string, handler: WebContentsHandler) => {
      handlers.set(event, handler)
    },
    send: (channel: string, ...args: unknown[]) => {
      sent.push([channel, args[0]])
    },
  }
  const win = { webContents } as unknown as Parameters<typeof wireZoom>[0]
  return { win, webContents, handlers, sent }
}

describe("wireZoom", () => {
  test("resets zoom factor to 1 on creation", () => {
    const { win, webContents } = makeFakeWindow()
    webContents.setZoomFactor(1.2)

    wireZoom(win)

    expect(webContents.getZoomFactor()).toBe(1)
  })

  test("intercepts user zoom gesture, calls preventDefault and forces zoom back to 1", () => {
    const { win, webContents, handlers } = makeFakeWindow()
    wireZoom(win)
    // A user gesture (pinch / Ctrl-scroll) moves zoom away from 100% first.
    webContents.setZoomFactor(1.4)
    const preventDefault = {
      called: false,
      call() {
        this.called = true
      },
    }
    const handler = handlers.get("zoom-changed")
    expect(handler).toBeDefined()

    handler?.({ preventDefault: () => (preventDefault.called = true) })

    expect(preventDefault.called).toBe(true)
    expect(webContents.getZoomFactor()).toBe(1)
  })

  test("leaves programmatic zoom untouched (keyboard / menu zoom)", () => {
    const { win, webContents } = makeFakeWindow()
    wireZoom(win)

    // Programmatic setZoomFactor does not fire the user-gesture zoom-changed event.
    webContents.setZoomFactor(1.2)

    expect(webContents.getZoomFactor()).toBe(1.2)
  })

  test("syncs zoom factor state to the renderer after a gesture", () => {
    const { win, webContents, handlers, sent } = makeFakeWindow()
    wireZoom(win)
    webContents.setZoomFactor(1.4)
    const handler = handlers.get("zoom-changed")
    handler?.({ preventDefault() {} })

    const zoomChanged = sent.find(([channel]) => channel === "zoom-factor-changed")
    expect(zoomChanged).toBeDefined()
    expect(zoomChanged?.[1]).toBe(1)
  })
})
