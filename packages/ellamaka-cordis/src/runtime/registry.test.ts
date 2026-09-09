import { describe, expect, test } from "bun:test"
import {
  CANDIDATE_REGISTRIES,
  DEFAULT_REGISTRY,
  pickFastestRegistry,
  probeRegistry,
  type FetchLike,
  type RegistryCandidate,
} from "./registry"

/** A stub fetch that returns a response after a per-candidate delay. */
function delayedFetch(delays: Record<string, number>): FetchLike {
  return async (url: string) => {
    const cand = CANDIDATE_REGISTRIES.find((c) => url.startsWith(c.url))
    const delay = cand ? (delays[cand.name] ?? 100) : 100
    await new Promise((r) => setTimeout(r, delay))
    return { status: 200, ok: true }
  }
}

describe("probeRegistry", () => {
  test("measures the round-trip latency of a reachable registry", async () => {
    const cand: RegistryCandidate = { name: "npm", url: "https://registry.npmjs.org/" }
    const fetchFn: FetchLike = async () => {
      await new Promise((r) => setTimeout(r, 50))
      return { status: 200, ok: true }
    }
    const result = await probeRegistry(fetchFn, cand)
    expect(result.latencyMs).toBeGreaterThanOrEqual(40)
    expect(result.latencyMs).toBeLessThan(500)
  })

  test("reports Infinity for an unreachable registry", async () => {
    const cand: RegistryCandidate = { name: "npm", url: "https://registry.npmjs.org/" }
    const fetchFn: FetchLike = async () => {
      throw new Error("network down")
    }
    const result = await probeRegistry(fetchFn, cand)
    expect(result.latencyMs).toBe(Infinity)
  })

  test("reports Infinity when the probe times out", async () => {
    const cand: RegistryCandidate = { name: "npm", url: "https://registry.npmjs.org/" }
    const fetchFn: FetchLike = async () => {
      await new Promise(() => {})
    }
    const result = await probeRegistry(fetchFn, cand, 20)
    expect(result.latencyMs).toBe(Infinity)
  })
})

describe("pickFastestRegistry", () => {
  test("returns the fastest reachable candidate", async () => {
    const fetchFn = delayedFetch({ npm: 200, taobao: 30, huawei: 150 })
    const winner = await pickFastestRegistry(fetchFn)
    expect(winner.name).toBe("taobao")
    expect(winner.url).toBe("https://registry.npmmirror.com/")
  })

  test("skips unreachable candidates and picks the fastest reachable", async () => {
    const fetchFn = delayedFetch({ npm: 300, cnpm: 500 })
    // Make tencent/huawei/etc fail.
    const failing: FetchLike = async (url) => {
      const cand = CANDIDATE_REGISTRIES.find((c) => url.startsWith(c.url))
      if (cand && (cand.name === "tencent" || cand.name === "huawei")) throw new Error("down")
      return delayedFetch({ npm: 300, taobao: 40, cnpm: 500, yarn: 200 })(url)
    }
    const winner = await pickFastestRegistry(failing)
    expect(winner.name).toBe("taobao")
  })

  test("falls back to DEFAULT_REGISTRY when all candidates fail", async () => {
    const fetchFn: FetchLike = async () => {
      throw new Error("all down")
    }
    const winner = await pickFastestRegistry(fetchFn)
    expect(winner.url).toBe(DEFAULT_REGISTRY)
  })

  test("honours a custom candidate list", async () => {
    const only: RegistryCandidate[] = [{ name: "custom", url: "https://custom.example/" }]
    const fetchFn: FetchLike = async () => {
      await new Promise((r) => setTimeout(r, 10))
      return { status: 200 }
    }
    const winner = await pickFastestRegistry(fetchFn, only)
    expect(winner.name).toBe("custom")
  })
})
