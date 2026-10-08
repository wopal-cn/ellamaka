import { Effect, Layer } from "effect"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { CrossSpawnSpawner } from "@wopal/ellamaka-core/cross-spawn-spawner"
import { EffectFlock } from "@wopal/ellamaka-core/util/effect-flock"
import { Auth } from "../../src/auth"

// Layer wiring shared by `config.test.ts` (unit) and `config-integration.test.ts`
// (live I/O). Both drive the same `Config.layer`, so the infra/flock/auth
// fixtures live here as one copy instead of drifting apart in two files.
// This is not a `*.test.ts` file, so the unit layer ignores it.

/** Infra layer that provides FileSystem, Path, ChildProcessSpawner for test fixtures */
export const infra = CrossSpawnSpawner.defaultLayer.pipe(
  Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
)

export const testFlock = EffectFlock.defaultLayer

export const wellKnownAuth = (url: string) =>
  Layer.mock(Auth.Service)({
    all: () =>
      Effect.succeed({
        [url]: new Auth.WellKnown({ type: "wellknown", key: "TEST_TOKEN", token: "test-token" }),
      }),
  })
