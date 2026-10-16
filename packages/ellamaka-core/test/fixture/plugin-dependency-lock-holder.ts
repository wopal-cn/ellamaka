import path from "node:path"
import { access, mkdir, writeFile } from "node:fs/promises"
import { Effect, Layer } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import { AppFileSystem } from "../../src/filesystem"
import { Global } from "../../src/global"
import { EffectFlock } from "../../src/util/effect-flock"

const [, , wopalHome, directory, acquiredFile, releaseFile] = process.argv
if (!wopalHome || !directory || !acquiredFile || !releaseFile) {
  throw new Error("usage: plugin-dependency-lock-holder <wopalHome> <directory> <acquiredFile> <releaseFile>")
}

const state = path.join(wopalHome, "ellamaka", "state")
const locks = path.join(state, "locks")
const global = Global.layerWith({ wopalHome, state })
const layer = EffectFlock.layer.pipe(
  Layer.provide(AppFileSystem.layer),
  Layer.provide(global),
  Layer.provide(NodeFileSystem.layer),
)

await Effect.gen(function* () {
  const flock = yield* EffectFlock.Service
  yield* flock.withLock(
    Effect.promise(async () => {
      await mkdir(path.dirname(acquiredFile), { recursive: true })
      await writeFile(acquiredFile, "acquired")
      for (;;) {
        if (
          await access(releaseFile).then(
            () => true,
            () => false,
          )
        )
          return
        await Bun.sleep(10)
      }
    }),
    `plugin-dependencies:dir:${path.resolve(directory)}`,
    locks,
  )
}).pipe(Effect.scoped, Effect.provide(layer), Effect.runPromise)
