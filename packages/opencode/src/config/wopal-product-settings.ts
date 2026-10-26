import { readDshWebEnabled } from "@wopal/wopalspace"
export { readDshWebEnabled } from "@wopal/wopalspace"

export async function resolveDshProfileIntent(
  wopalHome: string,
  env: Record<string, string | undefined> = process.env,
): Promise<{
  web: boolean
  tools: boolean
  profiles: readonly ("web" | "ellamaka-tools")[]
}> {
  const web = await readDshWebEnabled(wopalHome)
  const tools = env.ELLAMAKA_DSH_TOOLS !== "0"
  return {
    web,
    tools,
    profiles: [
      ...(web ? (["web"] as const) : []),
      ...(tools ? (["ellamaka-tools"] as const) : []),
    ],
  }
}
