/**
 * Runtime registry selection for DSH materialisation.
 *
 * The materialiser needs a registry to fetch the exact dependency versions
 * from. Instead of hard-coding one origin, this module probes a curated set of
 * candidate registries at materialisation time and picks the fastest reachable
 * one for the current user's network. This lets users in different regions
 * (CN mirrors vs global npm) install dependencies through the fastest channel
 * without any configuration.
 *
 * The registry is a TRANSPORT channel, never a version truth source: exact
 * dependency versions come from the manifest (DESIGN §3.4.3). Switching
 * registries changes neither the installed versions nor the closure
 * fingerprint.
 *
 * Candidates are ordered by expected reliability; probing is concurrent and
 * the first success wins (lowest measured latency). A slow/offline candidate
 * never blocks: the probe races all of them and falls back to the default.
 */

/** A fetch-compatible probe signature (tests inject a stub). */
export type FetchLike = (url: string, init?: RequestInit) => Promise<unknown>

/** A single candidate registry origin (trailing slash). */
export interface RegistryCandidate {
  readonly name: string
  readonly url: string
}

/**
 * Ordered candidate registries. The probe issues one HEAD/GET to a tiny
 * metadata endpoint per candidate concurrently and measures round-trip time.
 * The order only affects tie-breaking among equal latencies.
 */
export const CANDIDATE_REGISTRIES: readonly RegistryCandidate[] = [
  { name: "npm", url: "https://registry.npmjs.org/" },
  { name: "taobao", url: "https://registry.npmmirror.com/" },
  { name: "tencent", url: "https://mirrors.tencent.com/npm/" },
  { name: "huawei", url: "https://repo.huaweicloud.com/repository/npm/" },
  { name: "cnpm", url: "https://r.cnpmjs.org/" },
  { name: "npmMirror", url: "https://skimdb.npmjs.com/registry/" },
  { name: "yarn", url: "https://registry.yarnpkg.com/" },
]

/** The default fallback registry (used when every probe fails). */
export const DEFAULT_REGISTRY = "https://registry.npmjs.org/"

/** Probe path used to measure registry latency (a tiny metadata endpoint). */
const PROBE_PATH = "ellamaka-registry-probe"
/** How long a single probe may take before it is abandoned (ms). */
const PROBE_TIMEOUT_MS = 4000

/** The measured latency of one candidate. */
export interface RegistryProbeResult {
  readonly name: string
  readonly url: string
  /** Round-trip latency in ms; `Infinity` when the probe failed. */
  readonly latencyMs: number
}

/**
 * Probe a single registry and return its round-trip latency.
 * A failed (non-2xx, network error, or timeout) probe reports `Infinity`.
 */
export async function probeRegistry(
  fetchFn: FetchLike,
  candidate: RegistryCandidate,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<RegistryProbeResult> {
  const started = performance.now()
  try {
    const response = (await Promise.race([
      fetchFn(new URL(PROBE_PATH, candidate.url).href),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`probe timeout for ${candidate.name}`)), timeoutMs),
      ),
    ])) as { status?: unknown; ok?: unknown }
    // Any HTTP response counts as reachable (metadata endpoints return
    // 404/405 on an unknown path — that still proves the host+latency).
    if (response && (response.status === undefined || typeof response.status === "number")) {
      return { ...candidate, latencyMs: performance.now() - started }
    }
    return { ...candidate, latencyMs: Infinity }
  } catch {
    return { ...candidate, latencyMs: Infinity }
  }
}

/**
 * Concurrently probe every candidate and return the fastest reachable one.
 * Returns `DEFAULT_REGISTRY` (official npm) when all probes fail, so
 * materialisation always has a channel to try.
 *
 * @param fetchFn - the fetch implementation (tests inject a stub).
 * @param candidates - the candidate list (defaults to {@link CANDIDATE_REGISTRIES}).
 * @returns the winning registry URL (trailing slash).
 */
export async function pickFastestRegistry(
  fetchFn: FetchLike,
  candidates: readonly RegistryCandidate[] = CANDIDATE_REGISTRIES,
): Promise<RegistryProbeResult> {
  const results = await Promise.all(candidates.map((c) => probeRegistry(fetchFn, c)))
  const reachable = results
    .filter((r) => Number.isFinite(r.latencyMs))
    .sort((a, b) => a.latencyMs - b.latencyMs)
  if (reachable.length === 0) {
    const fallback = candidates.find((c) => c.url === DEFAULT_REGISTRY) ?? {
      name: "npm",
      url: DEFAULT_REGISTRY,
    }
    return { name: fallback.name, url: fallback.url, latencyMs: Infinity }
  }
  return reachable[0]
}
