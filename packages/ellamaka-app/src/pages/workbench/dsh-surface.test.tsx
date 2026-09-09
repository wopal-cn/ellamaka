/** @jsx h */
import { describe, expect, test } from "bun:test"
import { render } from "solid-js/web"
import h from "solid-js/h"
import {
  DshIframe,
  createDsh401Healer,
  dshIframeSrc,
  dshSurfaceStyle,
  looksLikeDsh401,
  selfHealDshIframe,
} from "./dsh-surface"

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

/**
 * auth-fix-2 (iframe 401 self-heal): the keep-alive iframe never reloads on
 * tab switches, so a stale cookie (30-day expiry, or an engine restart that
 * rotated the token+signing key) leaves a bare 401 page on screen forever.
 * After a load, the content is probed; a dsh 401 body triggers ONE re-fetch
 * of `/workbench/dsh-url` and a src reload (the fresh token re-mints the
 * cookie via the 303 exchange). A single failure only retries once — no
 * storm; a healthy document never triggers anything.
 */
describe("dsh 401 self-heal probe (auth-fix-2)", () => {
  test("detects the official dsh 401 body text", () => {
    expect(
      looksLikeDsh401("dsh web authentication required; reopen the URL printed by dsh web.\n"),
    ).toBe(true)
  })

  test("does not treat healthy content or empty documents as a 401", () => {
    expect(looksLikeDsh401("<!DOCTYPE html><html><body>__DSH_BOOT__</body></html>")).toBe(false)
    expect(looksLikeDsh401("")).toBe(false)
    expect(looksLikeDsh401("forbidden")).toBe(false)
  })

  test("reloads the iframe src on a detected 401 using the refetched entry", async () => {
    const iframe = document.createElement("iframe")
    iframe.setAttribute("src", "http://localhost:4097/dsh/?token=stale")
    document.body.appendChild(iframe)
    let entryCalls = 0
    const resolveEntry = async () => {
      entryCalls += 1
      return "http://localhost:4097/dsh/?token=fresh"
    }
    selfHealDshIframe(iframe, resolveEntry)
    // The reload is deferred to the next microtask/frame; wait it out.
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(entryCalls).toBe(1)
    expect(iframe.getAttribute("src")).toBe("http://localhost:4097/dsh/?token=fresh")
    iframe.remove()
  })

  test("stops after one retry when the entry is undefined (engine not mounted)", async () => {
    const iframe = document.createElement("iframe")
    iframe.setAttribute("src", "http://localhost:4097/dsh/?token=stale")
    document.body.appendChild(iframe)
    let entryCalls = 0
    const resolveEntry = async () => {
      entryCalls += 1
      return undefined
    }
    selfHealDshIframe(iframe, resolveEntry)
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(entryCalls).toBe(1)
    expect(iframe.getAttribute("src")).toBe("http://localhost:4097/dsh/?token=stale")
    iframe.remove()
  })

  test("does not retry when the refetched entry equals the current src", async () => {
    const iframe = document.createElement("iframe")
    iframe.setAttribute("src", "http://localhost:4097/dsh/?token=same")
    document.body.appendChild(iframe)
    let entryCalls = 0
    const resolveEntry = async () => {
      entryCalls += 1
      return "http://localhost:4097/dsh/?token=same"
    }
    selfHealDshIframe(iframe, resolveEntry)
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(entryCalls).toBe(1)
    // Unchanged entry: force the in-place reload instead of a no-op src set.
    expect(iframe.getAttribute("src")).toBe("http://localhost:4097/dsh/?token=same")
    iframe.remove()
  })

  test("keeps the keep-alive contract: heal only touches src, never the element", async () => {
    const iframe = document.createElement("iframe")
    iframe.setAttribute("src", "http://localhost:4097/dsh/?token=stale")
    document.body.appendChild(iframe)
    const before = iframe
    selfHealDshIframe(iframe, async () => "http://localhost:4097/dsh/?token=fresh")
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(iframe).toBe(before)
    expect(document.body.contains(before)).toBe(true)
    iframe.remove()
  })
})

describe("createDsh401Healer episode semantics (auth-fix-2)", () => {
  const FRESH = (n: number) => `http://localhost:4097/dsh/?token=fresh-${n}`

  function healerHarness() {
    const iframe = document.createElement("iframe")
    iframe.setAttribute("src", "http://localhost:4097/dsh/?token=stale")
    document.body.appendChild(iframe)
    let calls = 0
    const heal = createDsh401Healer({
      getFrame: () => iframe,
      refetchEntry: async () => FRESH(++calls),
    })
    return { iframe, heal, calls: () => calls }
  }

  test("healthy probes never refetch", async () => {
    const { heal, calls, iframe } = healerHarness()
    heal("<!DOCTYPE html><html><body>__DSH_BOOT__</body></html>")
    heal(null)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(calls()).toBe(0)
    iframe.remove()
  })

  test("consecutive 401 loads trigger exactly one attempt (no storm)", async () => {
    const { heal, calls, iframe } = healerHarness()
    heal("dsh web authentication required; reopen the URL printed by dsh web.\n")
    // The src reload lands on a still-stale session: the load probe fires 401 again.
    heal("dsh web authentication required; reopen the URL printed by dsh web.\n")
    heal("dsh web authentication required; reopen the URL printed by dsh web.\n")
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(calls()).toBe(1)
    iframe.remove()
  })

  test("a healthy load re-arms the healer so a later episode heals again", async () => {
    const { heal, calls, iframe } = healerHarness()
    heal("dsh web authentication required; reopen the URL printed by dsh web.\n")
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(calls()).toBe(1)
    // The healed src reloaded into a healthy surface, then the cookie expired
    // again weeks later: a NEW failure episode must heal once more.
    heal("<!DOCTYPE html><html><body>__DSH_BOOT__</body></html>")
    heal("dsh web authentication required; reopen the URL printed by dsh web.\n")
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(calls()).toBe(2)
    iframe.remove()
  })
})
