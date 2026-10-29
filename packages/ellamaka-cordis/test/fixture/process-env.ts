/** Own only the named keys; restore exact values on normal and exceptional exit.
 * Process-global scopes must not overlap concurrent tests. Import-time readers
 * need dependency injection or a separate process instead.
 */
export function scopedEnv(
  values: Record<string, string | undefined>,
  environment: Record<string, string | undefined> = process.env,
): Disposable {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, environment[key]]))
  const apply = (entries: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(entries)) {
      if (value === undefined) delete environment[key]
      else environment[key] = value
    }
  }
  apply(values)
  return { [Symbol.dispose]: () => apply(previous) }
}
