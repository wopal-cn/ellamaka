import type { Config } from "@wopal/ellamaka-sdk/v2/client"
import { readSandboxOptions, type DshRuntimeStatus } from "./prompt-input/sandbox-control"

/** Configured extensions plus the enabled product-owned sandbox adapter. */
export function statusPlugins(plugins: Config["plugin"], sandbox: unknown, dshStatus?: DshRuntimeStatus) {
  const configured = (plugins ?? []).map((item) => ({
    name: typeof item === "string" ? item : item[0],
    builtin: false,
  }))
  if (dshStatus !== "ready" || readSandboxOptions(sandbox)?.enabled !== true) return configured
  return [{ name: "dsh-adapter", builtin: true }, ...configured.filter((item) => item.name !== "dsh-adapter")]
}
