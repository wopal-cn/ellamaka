import path from "path"
import fs from "fs/promises"
import os from "os"
import { Context, Effect, Layer } from "effect"
import { Flock } from "./util/flock"
import { Flag } from "./flag/flag"
const wopalHomeRaw = process.env.WOPAL_HOME || path.join(os.homedir(), ".wopal")
const expandHome = (value: string) => (value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value)
const wopalRoot = expandHome(wopalHomeRaw)
const opencodeConfig = path.join(
  expandHome(process.env.XDG_CONFIG_HOME || path.join(process.env.OPENCODE_TEST_HOME ?? os.homedir(), ".config")),
  "opencode",
)
const data = path.join(wopalRoot, "ellamaka", "data")
const cache = path.join(wopalRoot, "ellamaka", "cache")
const config = path.join(wopalRoot, "config")
const state = path.join(wopalRoot, "ellamaka", "state")
const tmp = path.join(os.tmpdir(), "ellamaka")

const paths = {
  get home() {
    return process.env.OPENCODE_TEST_HOME ?? os.homedir()
  },
  wopalHome: wopalRoot,
  data,
  bin: path.join(cache, "bin"),
  log: path.join(wopalRoot, "logs"),
  repos: path.join(data, "repos"),
  cache,
  config,
  opencodeConfig,
  state,
  tmp,
}

export const Path = paths

Flock.setGlobal({ state })

await Promise.all([
  fs.mkdir(Path.data, { recursive: true }),
  fs.mkdir(Path.config, { recursive: true }),
  fs.mkdir(Path.state, { recursive: true }),
  fs.mkdir(Path.tmp, { recursive: true }),
  fs.mkdir(Path.log, { recursive: true }),
  fs.mkdir(Path.bin, { recursive: true }),
  fs.mkdir(Path.repos, { recursive: true }),
])

export class Service extends Context.Service<Service, Interface>()("@opencode/Global") {}

export interface Interface {
  readonly home: string
  readonly wopalHome: string
  readonly data: string
  readonly cache: string
  readonly config: string
  readonly opencodeConfig: string
  readonly state: string
  readonly tmp: string
  readonly bin: string
  readonly log: string
  readonly repos: string
}

export function make(input: Partial<Interface> = {}): Interface {
  return {
    home: Path.home,
    wopalHome: Path.wopalHome,
    data: Path.data,
    cache: Path.cache,
    config: Flag.OPENCODE_CONFIG_DIR ?? Path.config,
    opencodeConfig: Path.opencodeConfig,
    state: Path.state,
    tmp: Path.tmp,
    bin: Path.bin,
    log: Path.log,
    repos: Path.repos,
    ...input,
  }
}

export const layer = Layer.effect(
  Service,
  Effect.sync(() => Service.of(make())),
)

export const defaultLayer = layer

export const layerWith = (input: Partial<Interface>) =>
  Layer.effect(
    Service,
    Effect.sync(() => Service.of(make(input))),
  )

export * as Global from "./global"
