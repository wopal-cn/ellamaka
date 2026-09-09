export * as ConfigDsh from "./dsh"

import { Schema } from "effect"

/**
 * DSH (DeepSeek Harness) engine configuration. This is the settings.jsonc
 * DEFAULT-VALUE layer for the dsh web profile: values here ride the official
 * plugin-config path (patch layer -> plugin Config schema), so the host never
 * reimplements dsh's own authentication or fencing.
 */
export const Settings = Schema.Struct({
  /**
   * Non-loopback authorities the dsh connection Host/Origin fence accepts
   * (`host:port`, or port-less `host` matching any port). LAN deployments set
   * this to the machine's LAN IP so the Workbench iframe does not fail with a
   * silent 403. Defaults to `[]` (loopback-only, the official default).
   */
  trustedHosts: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "Non-loopback Host authorities accepted by the dsh connection fence (LAN deployment support)",
  }),
}).annotate({ identifier: "DshConfig" })
export type Settings = Schema.Schema.Type<typeof Settings>
