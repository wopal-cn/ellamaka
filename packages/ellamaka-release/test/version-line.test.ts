import { describe, expect, test } from "bun:test"
import { parseVersion, inferNextVersion } from "../src/version-line"

describe("parseVersion", () => {
  test("parses base versions", () => {
    expect(parseVersion("2.0.4")).toEqual({ base: [2, 0, 4], kind: null, n: 0 })
  })
  test("parses prerelease versions", () => {
    expect(parseVersion("2.0.4-rc.1")).toEqual({ base: [2, 0, 4], kind: "rc", n: 1 })
    expect(parseVersion("2.0.5-beta.3")).toEqual({ base: [2, 0, 5], kind: "beta", n: 3 })
  })
  test("throws on non-semantic versions", () => {
    expect(() => parseVersion("abc")).toThrow()
    expect(() => parseVersion("2.0")).toThrow()
  })
})

// 每产品独立、以已发布记录推断。产品历史 = { stable: 最高已发 X.Y.Z,
// candidate: 该产品通道最高已发 -rc.N / -beta.N }。

describe("inferNextVersion — candidate (rc/beta)", () => {
  test("cli: stable 已到 2.0.4 且无 rc → --rc 给 2.0.5-rc.1", () => {
    expect(inferNextVersion({ stable: "2.0.4" }, "rc")).toBe("2.0.5-rc.1")
  })

  test("desktop: stable 2.0.4、beta 最高 2.0.4-beta.1（base 已转正）→ 2.0.5-beta.1", () => {
    expect(inferNextVersion({ stable: "2.0.4", candidate: "2.0.4-beta.1" }, "beta")).toBe(
      "2.0.5-beta.1",
    )
  })

  test("候选 base 未转正（高于已发 stable）→ 续 N+1；base 已转正则开下一 patch", () => {
    // cli 已发 2.0.5-rc.1（stable 仍 2.0.4）→ 续 .2
    expect(inferNextVersion({ stable: "2.0.4", candidate: "2.0.5-rc.1" }, "rc")).toBe("2.0.5-rc.2")
    // desktop：beta 2.0.5-beta.1 的 base 2.0.5 已被 stable 转正（stable 2.0.5）
    // → 该 base 的 beta 线终结，升下一 patch 开 2.0.6-beta.1
    expect(
      inferNextVersion({ stable: "2.0.5", candidate: "2.0.5-beta.1" }, "beta"),
    ).toBe("2.0.6-beta.1")
  })

  test("产品独立非同步：cli 在 2.0.6 序列，desktop 仍在 2.0.5 序列，各自续发", () => {
    // cli 已发 stable 2.0.5 + rc 2.0.6-rc.1 → 续 2.0.6-rc.2
    expect(inferNextVersion({ stable: "2.0.5", candidate: "2.0.6-rc.1" }, "rc")).toBe("2.0.6-rc.2")
    // desktop 独立最高 stable 2.0.4 + beta 2.0.5-beta.1 → 续 2.0.5-beta.2
    expect(
      inferNextVersion({ stable: "2.0.4", candidate: "2.0.5-beta.1" }, "beta"),
    ).toBe("2.0.5-beta.2")
  })

  test("从未发布任何版本 → 从种子 base 起 -rc.1", () => {
    expect(inferNextVersion({}, "rc")).toBe("0.1.0-rc.1")
    expect(inferNextVersion({}, "beta")).toBe("0.1.0-beta.1")
  })
})

describe("inferNextVersion — stable (--patch)", () => {
  test("候选 base 未转正 → 转正该 base", () => {
    expect(inferNextVersion({ stable: "2.0.4", candidate: "2.0.5-rc.1" }, "stable")).toBe("2.0.5")
    expect(
      inferNextVersion({ stable: "2.0.4", candidate: "2.0.5-beta.3" }, "stable"),
    ).toBe("2.0.5")
  })

  test("已发 stable R 且无未转正候选 → semver patch+1 直接发新正式版", () => {
    expect(inferNextVersion({ stable: "2.0.4" }, "stable")).toBe("2.0.5")
  })

  test("从未发 stable、有候选 → 转正候选 base 发首个正式版", () => {
    expect(inferNextVersion({ candidate: "2.0.5-rc.1" }, "stable")).toBe("2.0.5")
  })
})

describe("inferNextVersion — minor / major", () => {
  test("从现行 base 升位", () => {
    expect(inferNextVersion({ stable: "2.0.4" }, "minor")).toBe("2.1.0")
    expect(inferNextVersion({ stable: "2.0.4", candidate: "2.0.6-rc.1" }, "minor")).toBe("2.1.0")
    expect(inferNextVersion({ stable: "2.0.4" }, "major")).toBe("3.0.0")
  })
})

describe("inferNextVersion — explicit", () => {
  test("原样返回合法显式版本", () => {
    expect(inferNextVersion({ stable: "2.0.4" }, "rc", "2.0.6-rc.1")).toBe("2.0.6-rc.1")
  })

  test("低于已发布 stable 的显式版本被拒绝", () => {
    expect(() => inferNextVersion({ stable: "2.0.4" }, "rc", "2.0.3-rc.1")).toThrow(/单调/)
  })
})
