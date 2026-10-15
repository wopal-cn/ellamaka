import { join } from "node:path"

export type Layer = "unit" | "integration" | "e2e"
export type PackageName =
  | "opencode"
  | "ellamaka-app"
  | "ellamaka-desktop"
  | "ellamaka-cordis"
  | "ellamaka-core"
  | "wopalspace"
  | "all"
export type ConcretePackage = Exclude<PackageName, "all">

// Layer -> package -> script name mapping. A package that has no entry for a
// given layer (e.g. app has no integration layer) throws when selected
// explicitly; `all` silently filters to packages that support the layer.
const LAYER_SCRIPTS: Record<Layer, Partial<Record<ConcretePackage, string>>> = {
  unit: {
    opencode: "test:unit",
    "ellamaka-app": "test:unit",
    "ellamaka-desktop": "test",
    "ellamaka-cordis": "test:unit",
    "ellamaka-core": "test:unit",
    wopalspace: "test:unit",
  },
  integration: {
    opencode: "test:integration",
    "ellamaka-cordis": "test:integration",
    wopalspace: "test:integration",
  },
  e2e: {
    opencode: "test:e2e",
    "ellamaka-app": "test:e2e",
    "ellamaka-desktop": "test:e2e",
  },
}

const PACKAGES: ConcretePackage[] = [
  "opencode",
  "ellamaka-app",
  "ellamaka-desktop",
  "ellamaka-cordis",
  "ellamaka-core",
  "wopalspace",
]

export interface PlannedCommand {
  pkg: ConcretePackage
  command: string[]
}

// Returns the `bun run <script>` commands to execute for the given layer and
// package. `all` expands to every package that supports the layer (packages
// without the layer are filtered out). An explicit package that lacks the layer
// throws, as does an unknown package or layer.
export function planLayer(layer: string, pkg: string): PlannedCommand[] {
  if (layer !== "unit" && layer !== "integration" && layer !== "e2e") {
    throw new Error(`Invalid layer: ${layer}. Expected one of unit, integration, e2e.`)
  }
  let targets: ConcretePackage[]
  if (pkg === "all") {
    targets = PACKAGES.filter((target) => LAYER_SCRIPTS[layer][target])
  } else {
    const target = concretePackage(pkg)
    if (!target) {
      throw new Error(
        `Unknown package: ${pkg}. Expected one of opencode, ellamaka-app, ellamaka-desktop, ellamaka-cordis, ellamaka-core, wopalspace.`,
      )
    }
    targets = [target]
  }
  const commands: PlannedCommand[] = []
  for (const target of targets) {
    const script = LAYER_SCRIPTS[layer][target]
    if (!script) {
      throw new Error(`Package ${target} has no ${layer} layer.`)
    }
    commands.push({ pkg: target, command: ["bun", "run", script] })
  }
  return commands
}

function concretePackage(value: string): ConcretePackage | undefined {
  switch (value) {
    case "opencode":
    case "ellamaka-app":
    case "ellamaka-desktop":
    case "ellamaka-cordis":
    case "ellamaka-core":
    case "wopalspace":
      return value
    default:
      return undefined
  }
}

function packageDir(pkg: ConcretePackage): string {
  // script/ lives two levels below packages/ (packages/opencode/script), so
  // sibling package dirs are two ups + pkg.
  return join(import.meta.dir, "..", "..", pkg)
}

async function main() {
  const args = process.argv.slice(2)
  let layer: Layer = "unit"
  let pkg: PackageName = "all"

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === "--layer") {
      const value = args[++index]
      if (value === "unit" || value === "integration" || value === "e2e") {
        layer = value
      } else {
        console.error(`Unknown layer: ${value}. Expected one of unit, integration, e2e.`)
        process.exit(1)
      }
    } else if (arg === "--package") {
      const value = args[++index]
      if (
        value === "opencode" ||
        value === "ellamaka-app" ||
        value === "ellamaka-desktop" ||
        value === "ellamaka-cordis" ||
        value === "ellamaka-core" ||
        value === "wopalspace" ||
        value === "all"
      ) {
        pkg = value
      } else {
        console.error(
          `Unknown package: ${value}. Expected one of opencode, ellamaka-app, ellamaka-desktop, ellamaka-cordis, ellamaka-core, wopalspace, all.`,
        )
        process.exit(1)
      }
    } else {
      console.error(`Unknown argument: ${arg}`)
      process.exit(1)
    }
  }

  let commands: PlannedCommand[]
  try {
    commands = planLayer(layer, pkg)
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }

  // TEST_PLAN_OUTPUT=1 prints the planned commands instead of running them.
  if (Bun.env.TEST_PLAN_OUTPUT === "1") {
    console.log(JSON.stringify({ layer, pkg, commands }, null, 2))
    return
  }

  for (const planned of commands) {
    const proc = Bun.spawn(planned.command, {
      cwd: packageDir(planned.pkg),
      stdout: "inherit",
      stderr: "inherit",
      env: Bun.env,
    })
    const exitCode = await proc.exited
    if (exitCode !== 0) process.exit(exitCode ?? 1)
  }
}

if (import.meta.main) {
  void main()
}
