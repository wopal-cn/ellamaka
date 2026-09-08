// version-line.ts — 每产品独立、以已发布记录为唯一依据的版本推断。
//
// 背景（docs/DISTRIBUTION.md §3.2/§4.1）：cli 与 desktop 是两个独立发布单元，
// 各自版本序列独立推进，互不牵制。版本推进的唯一依据是**该产品已成功发布的
// git tag 记录**（最高 stable + 该产品通道的最高 prerelease），不再读取任何
// package.json 作为"版本线/锚点"候选状态——发布的版本只在发布动作内写入，成功
// 即成为记录；失败/中断不构成记录，可同版本重发。
//
// 依赖包（除 cli/desktop 外的全部 workspace 包）统一镜像纯 X.Y.Z base，取两个
// 产品现行 base 的较高者；base 镜像不属于本模块，由 release.sh 写入层负责。

export type PrereleaseKind = "rc" | "beta"
export type Bump = "rc" | "beta" | "stable" | "minor" | "major"

export interface ProductHistory {
  /** 该产品已发布的最高 stable 版本（X.Y.Z）；缺省表示从未发布 stable */
  stable?: string
  /** 该产品通道的最高 prerelease（X.Y.Z-rc.N 或 X.Y.Z-beta.N）；缺省表示无 */
  candidate?: string
}

export interface ParsedVersion {
  base: [number, number, number]
  kind: PrereleaseKind | null
  n: number
}

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-(rc|beta)\.(\d+))?$/

export function parseVersion(input: string): ParsedVersion {
  const m = input.trim().match(VERSION_RE)
  if (!m) throw new Error(`无效版本号: ${input} (期望 X.Y.Z 或 X.Y.Z-rc.N / X.Y.Z-beta.N)`)
  return {
    base: [Number(m[1]), Number(m[2]), Number(m[3])],
    kind: (m[4] as PrereleaseKind | undefined) ?? null,
    n: m[5] ? Number(m[5]) : 0,
  }
}

export function formatVersion(v: ParsedVersion): string {
  const base = v.base.join(".")
  return v.kind ? `${base}-${v.kind}.${v.n}` : base
}

export function compareBase(a: [number, number, number], b: [number, number, number]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
}

function patchPlusOne([a, b, c]: [number, number, number]): [number, number, number] {
  return [a, b, c + 1]
}

// 该产品现行"有效 base"：已发布 stable 与 prerelease base 中较高者。
// prerelease base ≤ 已发 stable 的视为已转正/已终结，不参与升位。
function effectiveBase(hist: ProductHistory): [number, number, number] {
  const s = hist.stable ? parseVersion(hist.stable) : null
  const c = hist.candidate ? parseVersion(hist.candidate) : null
  let best: [number, number, number] = [0, 1, 0]
  if (s && compareBase(s.base, best) > 0) best = s.base
  if (c && compareBase(c.base, best) > 0) best = c.base
  return best
}

// inferNextVersion — 从该产品已发布记录推断下一个发布版本。
//
//   rc / beta  → 该产品通道：现有候选序列的 base 若未转正（高于已发 stable）
//                则续 N+1，否则在已发 stable 的下一 patch 上开 -rc.1/-beta.1。
//   stable     → 无 stable 记录取现行候选 base 转正；已有 stable 则 semver
//                patch+1（2.0.4 → 2.0.5）直接发新正式版。
//   minor/major→ 现行 base 升位，通道重置。
//   explicit   → 校验 base 不低于已发 stable 后原样返回（同版本重发语义由调用方处理）。
//
// 全部推断只依赖 history（该产品已发布 tag），不读取 package.json。
export function inferNextVersion(
  history: ProductHistory,
  bump: Bump,
  explicit?: string,
): string {
  const s = history.stable ? parseVersion(history.stable) : null
  const c = history.candidate ? parseVersion(history.candidate) : null

  if (explicit) {
    const e = parseVersion(explicit)
    // 不允许回退到已发布 stable 之下（发布单调）。
    if (s && compareBase(e.base, s.base) < 0) {
      throw new Error(`显式版本 ${explicit} 低于已发布 stable ${history.stable}：发布必须单调递增`)
    }
    return explicit
  }

  // stable：候选 base 未转正则转正它，否则已发 stable patch+1。
  if (bump === "stable") {
    const openCandidate = c && (!s || compareBase(c.base, s.base) > 0)
    if (openCandidate) return formatVersion({ base: c!.base, kind: null, n: 0 })
    if (s) return formatVersion({ base: patchPlusOne(s.base), kind: null, n: 0 })
    // 从未发布 stable：以现行 base 发首个正式版
    return formatVersion({ base: effectiveBase(history), kind: null, n: 0 })
  }

  // minor / major：现行 base 升位。
  if (bump === "minor" || bump === "major") {
    const [a, b] = effectiveBase(history)
    const next: [number, number, number] =
      bump === "minor" ? [a, b + 1, 0] : [a + 1, 0, 0]
    return formatVersion({ base: next, kind: null, n: 0 })
  }

  // rc / beta：确认通道与历史一致。
  const kind: PrereleaseKind = bump
  if (c && c.kind && c.kind !== kind) {
    throw new Error(
      `已发布候选是 -${c.kind}.N 而本次请求 -${kind}.N：产品通道类型固定（cli=rc / desktop=beta），不得混用`,
    )
  }
  // 候选 base 未转正（高于已发 stable）→ 续 N+1。
  if (c && c.kind === kind && (!s || compareBase(c.base, s.base) > 0)) {
    return formatVersion({ base: c.base, kind, n: c.n + 1 })
  }
  // 否则在已发 stable 的下一 patch 上开 -kind.1；从未发布任何版本时从种子
  // base 0.1.0 起步。
  const nextBase = s ? patchPlusOne(s.base) : ([0, 1, 0] as [number, number, number])
  return formatVersion({ base: nextBase, kind, n: 1 })
}
