import { Context, Effect } from "effect"

type EffectMethod = (...args: ReadonlyArray<never>) => Effect.Effect<unknown, unknown, unknown>

type ServiceUse<Identifier, Shape> = {
  readonly [Key in keyof Shape as Shape[Key] extends EffectMethod ? Key : never]: Shape[Key] extends (
    ...args: infer Args
  ) => infer Return
    ? Args extends ReadonlyArray<unknown>
      ? Return extends Effect.Effect<infer A, infer E, infer R>
        ? (...args: Args) => Effect.Effect<A, E, R | Identifier>
        : never
      : never
    : never
}

export const serviceUse = <Identifier, Shape>(tag: Context.Service<Identifier, Shape>) => {
  const cache = new Map<string, (...args: unknown[]) => Effect.Effect<unknown, unknown, unknown>>()
  // This is the only dynamic boundary: TypeScript knows the accessor shape,
  // but Proxy property names are runtime values.
  const access = new Proxy(
    {},
    {
      get: (_, key) => {
        if (typeof key !== "string") return undefined
        const cached = cache.get(key)
        if (cached) return cached
        const accessor = (...args: unknown[]) =>
          tag.use((service) => {
            const method = service[key as keyof Shape]
            if (typeof method !== "function") return Effect.die(new Error(`Service method not found: ${key}`))
            return (method as (...args: unknown[]) => Effect.Effect<unknown, unknown, unknown>)(...args)
          })
        cache.set(key, accessor)
        return accessor
      },
    },
  )
  return access as ServiceUse<Identifier, Shape>
}
