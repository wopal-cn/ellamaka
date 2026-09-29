// Rule identity is a POSIX-style relative path: it is part of the HTTP/SDK
// contract, so a rule's `name` must not change with the host OS. Mirrors the
// normalization precedent in config/entry-name.ts.
export function normalizeRulePath(relativePath: string) {
  return relativePath.replaceAll("\\", "/")
}

// Only single-level subdirectories are agent scopes (`fae/astro.md` → "fae");
// root-level files and deeper paths carry no agent scope. Evaluated on the
// normalized path so the scope inference is OS-independent too.
export function inferAgentScope(relativePath: string): string | undefined {
  const parts = normalizeRulePath(relativePath).split("/")
  return parts.length === 2 ? parts[0] : undefined
}

export * as RuleName from "./name"
