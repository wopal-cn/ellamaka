/** Plural capability categories declared by an archetype manifest. */
export const capabilityKinds = ["agents", "skills", "rules", "commands", "plugins"] as const

export type CapabilityKind = (typeof capabilityKinds)[number]

/** Singular selection-reference kind per category. */
export const capabilityKindSingular: Readonly<Record<CapabilityKind, string>> = {
  agents: "agent",
  skills: "skill",
  rules: "rule",
  commands: "command",
  plugins: "plugin",
}

/** Reverse map from the singular selection kind. */
export const capabilityKindFromSingular: Readonly<Record<string, CapabilityKind>> = {
  agent: "agents",
  skill: "skills",
  rule: "rules",
  command: "commands",
  plugin: "plugins",
}

export function isCapabilityKind(value: string): value is CapabilityKind {
  return Object.hasOwn(capabilityKindFromSingular, value)
}
