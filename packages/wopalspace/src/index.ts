export const applicationDomains = ["setup", "ontology", "space", "product-settings"] as const

export type ApplicationDomain = (typeof applicationDomains)[number]

export interface HostContext {
  readonly wopalHome: string
  readonly directory?: string
}

export {
  DSH_WEB_ENABLED_KEY,
  ProductSettingsError,
  parseDshWebEnabled,
  readDshWebEnabled,
  updateDshWebEnabled,
} from "./product-settings"
