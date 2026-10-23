import { createPackageDshRuntimeApi } from "../../src/runtime/loader"
import { prepareDshProfileResourcesAtRoot } from "../../src/runtime/profile-resources"

/** Explicit test setup mirroring the profile-resource preparation phase. */
export function prepareDshProfiles(dshRoot: string): void {
  prepareDshProfileResourcesAtRoot(dshRoot, createPackageDshRuntimeApi())
}
