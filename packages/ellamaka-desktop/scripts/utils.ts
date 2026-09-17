export type Channel = "main" | "beta" | "stable"

export function resolveChannel(): Channel {
  const raw = Bun.env.ELLAMAKA_CHANNEL
  if (raw === "main" || raw === "beta" || raw === "stable") return raw
  return "main"
}
