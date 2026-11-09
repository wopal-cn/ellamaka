import type { OpencodeClient } from "@wopal/ellamaka-sdk/v2"
import { pluginClientOperations, type PluginClient } from "@wopal/ellamaka-plugin/client-compat"

type Descriptor = {
  readonly target: string | null
  readonly path?: Readonly<Record<string, string>>
  readonly query?: readonly string[]
  readonly body?: readonly string[]
  readonly whole?: string | null
  readonly params?: boolean
  readonly direct?: boolean
}
type LegacyInput = Record<string, unknown> & {
  path?: Record<string, unknown>
  query?: Record<string, unknown>
  body?: unknown
}

function member(value: unknown, key: string): unknown {
  if (!value || (typeof value !== "object" && typeof value !== "function"))
    throw new Error("expected plugin client object")
  return Reflect.get(value, key)
}

/** Adapt the plugin's nested request shape to the canonical generated client. */
export function createPluginClient(client: OpencodeClient): PluginClient {
  const result: Record<string, unknown> = {}
  for (const [name, descriptor] of Object.entries(pluginClientOperations) as [string, Descriptor][]) {
    const keys = name.split(".")
    const method = keys.pop()!
    let branch = result
    for (const key of keys) {
      const child = Object.fromEntries(Object.entries(branch[key] ??= {}))
      branch[key] = child
      branch = child
    }
    branch[method] = (input: LegacyInput = {}) => {
      if (!descriptor.target) throw new Error(`Plugin operation ${name} is unsupported by this Runtime`)
      const target = descriptor.target.split(".")
      const targetMethod = target.pop()!
      let owner: object = client
      for (const key of target) {
        const next = member(owner, key)
        if (!next || (typeof next !== "object" && typeof next !== "function"))
          throw new Error(`Plugin operation ${name} has no canonical SDK method`)
        owner = next
      }
      const invoke = member(owner, targetMethod)
      if (typeof invoke !== "function") throw new Error(`Plugin operation ${name} has no canonical SDK method`)
      const { path = {}, query = {}, body, ...options } = input
      if (!descriptor.params) return invoke.call(owner, options)
      const parameters: Record<string, unknown> = {}
      for (const [oldName, newName] of Object.entries(descriptor.path ?? {})) {
        if (oldName in path) parameters[newName] = path[oldName]
      }
      for (const [key, value] of Object.entries(query)) {
        parameters[descriptor.query?.includes(key) ? key : `$query_${key}`] = value
      }
      if (descriptor.direct)
        for (const key of descriptor.query ?? [])
          if (key in options) {
            parameters[key] = options[key]
            delete options[key]
          }
      if (body !== undefined) {
        if (descriptor.whole) parameters[descriptor.whole] = body
        else if (body && typeof body === "object" && !Array.isArray(body)) {
          for (const [key, value] of Object.entries(body)) {
            parameters[descriptor.body?.includes(key) ? key : `$body_${key}`] = value
          }
        } else throw new Error(`Plugin operation ${name} requires an object body`)
      }
      return invoke.call(owner, parameters, options)
    }
  }
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- the nested shape is constructed from the exhaustive descriptor table above.
  return result as PluginClient
}
