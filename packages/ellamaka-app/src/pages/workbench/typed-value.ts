/** Read a numeric status from a nested unknown error object. */
export function nestedStatus(error: unknown, field: "response" | "cause"): number | undefined {
  if (!error || typeof error !== "object" || !Object.hasOwn(error, field)) return undefined
  const nested: unknown = Object.getOwnPropertyDescriptor(error, field)?.value
  if (!nested || typeof nested !== "object" || !Object.hasOwn(nested, "status")) return undefined
  const status: unknown = Object.getOwnPropertyDescriptor(nested, "status")?.value
  return typeof status === "number" ? status : undefined
}
