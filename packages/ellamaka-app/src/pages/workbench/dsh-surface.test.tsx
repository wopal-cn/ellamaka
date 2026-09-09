/** @jsx h */
import { describe, expect, test } from "bun:test"
import { render } from "solid-js/web"
import h from "solid-js/h"
import { DshIframe, dshIframeSrc, dshSurfaceStyle } from "./dsh-surface"

/**
 * The DSH iframe embeds the DSH web UI under the backend origin's `/dsh/` path
 * (single-port scheme, DESIGN-dsh-poc §2.1). The iframe src is derived from the
 * active server URL. A serving page that owns a `/dsh` proxy retargets the
 * iframe onto its own origin.
 */
describe("dshIframeSrc", () => {
  test("derives the backend /dsh/ URL from a server URL", () => {
    expect(dshIframeSrc("http://localhost:4097")).toBe("http://localhost:4097/dsh/")
    expect(dshIframeSrc("http://127.0.0.1:4097")).toBe("http://127.0.0.1:4097/dsh/")
  })

  test("preserves an existing path on the server URL", () => {
    expect(dshIframeSrc("http://localhost:4097/base")).toBe("http://localhost:4097/dsh/")
  })

  test("uses the authenticated entry when the server reports one", () => {
    expect(dshIframeSrc("http://localhost:4097", "http://localhost:4097/dsh/?token=abc")).toBe(
      "http://localhost:4097/dsh/?token=abc",
    )
    // An authenticated entry from a genuinely different host (stale server
    // info) is not used; the derivation falls back to the current server URL.
    expect(dshIframeSrc("http://localhost:4097", "http://192.168.1.111:4097/dsh/?token=abc")).toBe(
      "http://localhost:4097/dsh/",
    )
  })

  test("treats loopback aliases (localhost / 127.0.0.1) as one origin", () => {
    // The backend reports its entry on 127.0.0.1 while the frontend SDK
    // remembered the server URL on localhost — the same physical loopback
    // server. The launch-token entry must be honored, not discarded as stale.
    expect(dshIframeSrc("http://localhost:4097", "http://127.0.0.1:4097/dsh/?token=abc")).toBe(
      "http://127.0.0.1:4097/dsh/?token=abc",
    )
    // In the proxied dev topology the entry retargets onto the page origin.
    expect(
      dshIframeSrc("http://localhost:4097", "http://127.0.0.1:4097/dsh/?token=abc", "http://localhost:3000"),
    ).toBe("http://localhost:3000/dsh/?token=abc")
  })

  test("retargets the entry onto the page origin in the proxied dev topology", () => {
    // The backend reports :4097; the Vite page proxies /dsh on :3000 — the
    // SameSite=Strict cookie forces iframe and cookie onto one origin.
    expect(
      dshIframeSrc("http://127.0.0.1:4097", "http://127.0.0.1:4097/dsh/?token=abc", "http://localhost:3000"),
    ).toBe("http://localhost:3000/dsh/?token=abc")
    // Tokenless fallback derivation also lands on the page origin.
    expect(dshIframeSrc("http://127.0.0.1:4097", undefined, "http://localhost:3000")).toBe(
      "http://localhost:3000/dsh/",
    )
    // The packaged Desktop renderer owns the proxy through its privileged
    // `oc://renderer` origin.
    expect(
      dshIframeSrc("http://127.0.0.1:4097", "http://127.0.0.1:4097/dsh/?token=abc", "oc://renderer"),
    ).toBe("oc://renderer/dsh/?token=abc")
    expect(dshIframeSrc("http://127.0.0.1:4097", undefined, "oc://renderer")).toBe("oc://renderer/dsh/")
  })

  test("returns undefined for an empty server URL", () => {
    expect(dshIframeSrc("")).toBeUndefined()
    expect(dshIframeSrc(undefined)).toBeUndefined()
  })
})

describe("DshIframe", () => {
  test("renders the DSH iframe at the given src", () => {
    const host = document.createElement("div")
    document.body.appendChild(host)
    render(() => <DshIframe src="http://localhost:4097/dsh/" />, host)

    const iframe = host.querySelector<HTMLIFrameElement>('iframe[title="DSH"]')
    expect(iframe).not.toBeNull()
    expect(iframe!.getAttribute("src")).toBe("http://localhost:4097/dsh/")

    host.remove()
  })
})


/**
 * DshSurface keep-alive contract (DESIGN-dsh-poc §10): the DSH iframe is the
 * Assistant tab's content, so both layers must stay mounted and only the
 * display style toggles — unmounting would reload the iframe and destroy DSH
 * session state, violating the Space Keep-Alive invariant.
 */
describe("dshSurfaceStyle keep-alive", () => {
  test("visible layer participates in layout, hidden layer drops out", () => {
    expect(dshSurfaceStyle(true)).toEqual({ display: "contents" })
    expect(dshSurfaceStyle(false)).toEqual({ display: "none" })
  })
})
