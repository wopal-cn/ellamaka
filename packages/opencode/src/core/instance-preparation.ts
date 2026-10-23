import path from "node:path"
import { realpath } from "node:fs/promises"
import {
  createCorePreparationService,
  type CorePreparationEvent,
  type CorePreparationResult,
  type CorePreparationService,
} from "@wopal/ellamaka-core/preparation"
import { createInstanceDependencyContributor } from "@wopal/ellamaka-core/plugin-dependencies"

const services = new Map<string, CorePreparationService>()

export function getInstancePreparationService(wopalHome: string): CorePreparationService {
  const normalized = path.resolve(wopalHome)
  const found = services.get(normalized)
  if (found) return found
  const service = createCorePreparationService({
    hostKey: `instance:${normalized}`,
    contributors: [createInstanceDependencyContributor({ wopalHome: normalized })],
  })
  services.set(normalized, service)
  return service
}

export async function getInstancePreparationTarget(directory: string) {
  const resolved = path.resolve(directory)
  const canonical = await realpath(resolved).catch(() => resolved)
  return { kind: "instance" as const, directory: canonical }
}

export async function prepareInstancePluginDependencies(options: {
  wopalHome: string
  directory: string
  reason: string
  signal?: AbortSignal
  onProgress?: (event: CorePreparationEvent) => void
}): Promise<CorePreparationResult> {
  const service = getInstancePreparationService(options.wopalHome)
  const target = await getInstancePreparationTarget(options.directory)
  const inspected = await service.inspect(target)
  if (inspected.state === "READY") return inspected
  return service.prepare({ target, reason: options.reason }, { signal: options.signal, onProgress: options.onProgress })
}
