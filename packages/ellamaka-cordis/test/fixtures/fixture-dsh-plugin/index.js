/**
 * Fixture dsh plugin: a standalone package the installer copies into the
 * plugin install area. Its bundle patch inserts one cordis entry whose apply
 * registers a marker service and counts mounts/disposals (hot-mount and
 * dispose evidence for the runtime integration test).
 */
export const name = "fixture-dsh-plugin"
export const version = "1.0.0"

export function apply(ctx) {
  ctx.provide("fixture-dsh-plugin.marker", "mounted")
  ctx.provide("fixture-dsh-plugin.service", {
    greet: () => "hello from fixture",
  })
  console.log("[fixture-dsh-plugin] mounted")
  return () => {
    console.log("[fixture-dsh-plugin] DISPOSED")
  }
}
