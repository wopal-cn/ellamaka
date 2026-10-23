export const applicationDomains = ["setup", "ontology", "space"] as const

export type ApplicationDomain = (typeof applicationDomains)[number]

export interface HostContext {
  readonly wopalHome: string
  readonly directory?: string
}
