/** Restore all named process environment keys after a test, including absent keys. */
export function scopedEnv(values: Record<string, string | undefined>): Disposable {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]))
  const apply = (entries: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(entries)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
  apply(values)
  return { [Symbol.dispose]: () => apply(previous) }
}
