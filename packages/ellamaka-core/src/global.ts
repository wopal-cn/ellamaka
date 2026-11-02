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
const tmp = path.join(os.tmpdir(), "ellamaka")

const paths = {
  get home() {
    return process.env.OPENCODE_TEST_HOME ?? os.homedir()
  },
  wopalHome: wopalRoot,
  data: path.join(wopalRoot, "ellamaka", "data"),
  bin: path.join(wopalRoot, "ellamaka", "cache", "bin"),
  log: path.join(wopalRoot, "logs"),
  repos: path.join(wopalRoot, "ellamaka", "data", "repos"),
  cache: path.join(wopalRoot, "ellamaka", "cache"),
  config: path.join(wopalRoot, "config"),
  opencodeConfig,
  state: path.join(wopalRoot, "ellamaka", "state"),
  tmp,
}

export const Path = paths

Flock.setGlobal({ state: Path.state })

/**
 * Rebase the current process onto one effective WOPAL_HOME without creating
 * any filesystem resource. The Onboarding host owns the one-lifecycle lock;
 * this low-level function only updates the process-local path view after that
 * policy has accepted a Home.
 */
export function bindWopalHome(value: string) {
  const root = expandHome(value)
  process.env.WOPAL_HOME = root
  Path.wopalHome = root
  Path.data = path.join(root, "ellamaka", "data")
  Path.cache = path.join(root, "ellamaka", "cache")
  Path.config = path.join(root, "config")
  Path.state = path.join(root, "ellamaka", "state")
  Path.bin = path.join(Path.cache, "bin")
  Path.log = path.join(root, "logs")
  Path.repos = path.join(Path.data, "repos")
  Flock.setGlobal({ state: Path.state })
  return root
}

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
  const overrides = input
  return {
    get home() {
      return overrides.home ?? Path.home
    },
    get wopalHome() {
      return overrides.wopalHome ?? Path.wopalHome
    },
    get data() {
      return overrides.data ?? Path.data
    },
    get cache() {
      return overrides.cache ?? Path.cache
    },
    get config() {
      return overrides.config ?? Flag.OPENCODE_CONFIG_DIR ?? Path.config
    },
    get opencodeConfig() {
      return overrides.opencodeConfig ?? Path.opencodeConfig
    },
    get state() {
      return overrides.state ?? Path.state
    },
    get tmp() {
      return overrides.tmp ?? Path.tmp
    },
    get bin() {
      return overrides.bin ?? Path.bin
    },
    get log() {
      return overrides.log ?? Path.log
    },
    get repos() {
      return overrides.repos ?? Path.repos
    },
  }
}

export async function ensure(input: Partial<Interface> = {}) {
  const paths = make(input)
  await Promise.all([
    fs.mkdir(paths.data, { recursive: true }),
    fs.mkdir(paths.config, { recursive: true }),
    fs.mkdir(paths.state, { recursive: true }),
    fs.mkdir(paths.tmp, { recursive: true }),
    fs.mkdir(paths.log, { recursive: true }),
    fs.mkdir(paths.bin, { recursive: true }),
    fs.mkdir(paths.repos, { recursive: true }),
  ])
}

/** Global paths are dependency data; constructing the layer never materializes Runtime storage. */
export const layer = Layer.effect(
  Service,
  Effect.sync(() => Service.of(make())),
)

export const layerWith = (input: Partial<Interface>) =>
  Layer.effect(
    Service,
    Effect.sync(() => Service.of(make(input))),
  )

export const defaultLayer = layer

export * as Global from "./global"
