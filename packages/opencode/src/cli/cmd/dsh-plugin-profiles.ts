/**
 * Pure helpers for the `ellamaka dsh plugin` command group (DESIGN-dsh-poc
 * §9.3): profile parsing with the `tools` alias, and `pkg[@version]` spec
 * splitting. Kept dependency-free so the CLI glue stays trivially testable.
 */

/** The two built-in profiles a plugin can be enabled in. */
export const BUILTIN_PROFILES: readonly string[] = ["web", "ellamaka-tools"]

/**
 * `tools` is the accepted CLI shorthand for the built-in `ellamaka-tools`
 * profile (Plan Task 6 / Scenario 1 use `--profile web,tools`).
 */
export const PROFILE_ALIASES: Record<string, string> = {
  tools: "ellamaka-tools",
}

/** Expand one user-supplied profile name through the alias table. */
export function canonicalProfile(name: string): string {
  return PROFILE_ALIASES[name] ?? name
}

/**
 * Parse the `--profile` flag: comma-separated names, `tools` aliased to
 * `ellamaka-tools`, empty/omitted defaults to both built-in profiles.
 * Unknown names throw with the built-in list.
 */
export function parseProfiles(spec: string | undefined): string[] {
  if (!spec || spec.trim() === "") return [...BUILTIN_PROFILES]
  const names = spec
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean)
  if (names.length === 0) return [...BUILTIN_PROFILES]
  const canonical = names.map(canonicalProfile)
  const unknown = canonical.filter((name) => !BUILTIN_PROFILES.includes(name))
  if (unknown.length > 0) {
    throw new Error(`unknown profile(s): ${unknown.join(", ")} (built-in: ${BUILTIN_PROFILES.join(", ")})`)
  }
  // Dedupe while keeping order (web,tools and tools,web both stay stable).
  return [...new Set(canonical)]
}

/** Parse `pkg[@version]` into an installer registry spec. */
export function parseRegistrySpec(spec: string): { kind: "registry"; name: string; version?: string } {
  if (spec.startsWith("@")) {
    const idx = spec.indexOf("@", 1)
    if (idx === -1) return { kind: "registry", name: spec }
    return { kind: "registry", name: spec.slice(0, idx), version: spec.slice(idx + 1) }
  }
  const idx = spec.indexOf("@")
  if (idx === -1) return { kind: "registry", name: spec }
  return { kind: "registry", name: spec.slice(0, idx), version: spec.slice(idx + 1) }
}