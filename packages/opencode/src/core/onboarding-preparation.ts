import { join } from "node:path"
import { Global } from "@wopal/ellamaka-core/global"
import { resolveDshProfileIntent } from "@/config/wopal-product-settings"
import { prepareDshProfiles, writeCorePreparationProgress } from "./preparation"
import { ensureRuntimeStorage } from "@/storage/runtime-bootstrap"

export async function prepareOnboardingRuntime(
  home = Global.Path.wopalHome,
  dependencies: {
    resolveIntent: typeof resolveDshProfileIntent
    prepare: typeof prepareDshProfiles
    ensureStorage?: typeof ensureRuntimeStorage
  } = {
    resolveIntent: resolveDshProfileIntent,
    prepare: prepareDshProfiles,
  },
) {
  await (dependencies.ensureStorage ?? ensureRuntimeStorage)()
  const intent = await dependencies.resolveIntent(home)
  const prepared = await dependencies.prepare({
    wopalHome: home,
    runtimeLogFile: join(Global.Path.log, "dsh-runtime.log"),
    profiles: intent.profiles,
    onProgress: writeCorePreparationProgress,
    print: process.argv.includes("--print-logs"),
  })
  const statuses = [prepared.web.status, prepared.tools.status]
  if (statuses.every((status) => status === "disabled")) return { status: "disabled" as const }
  if (statuses.includes("degraded")) {
    return { status: "degraded" as const, diagnostic: "One or more DSH profiles failed to prepare" }
  }
  return { status: "ready" as const }
}
