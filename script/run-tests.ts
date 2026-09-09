import { join } from "node:path"

export type Layer = "unit" | "integration" | "e2e"
export type PackageName = "opencode" | "ellamaka-app" | "ellamaka-desktop" | "all"
export type ConcretePackage = Exclude<PackageName, "all">

// Layer -> package -> script name mapping. A package that has no entry for a
// given layer (e.g. app has no integration layer) throws when selected
// explicitly; `all` silently filters to packages that support the layer.
const LAYER_SCRIPTS: Record<Layer, Partial<Record<ConcretePackage, string>>> = {
  unit: {
    opencode: "test:unit",
    "ellamaka-app": "test:unit",
    "ellamaka-desktop": "test",
  },
  integration: {
    opencode: "test:integration",
  },
  e2e: {
    opencode: "test:e2e",
    "ellamaka-app": "test:e2e",
    "ellamaka-desktop": "test:e2e",
  },
}

const PACKAGES: ConcretePackage[] = ["opencode", "ellamaka-app", "ellamaka-desktop"]

export interface PlannedCommand {
  pkg: ConcretePackage
  command: string[]
}

// Returns the `bun run <script>` commands to execute for the given layer and
// package. `all` expands to every package that supports the layer (packages
// without the layer are filtered out). An explicit package that lacks the layer
// throws, as does an unknown package or layer.
export function planLayer(layer: Layer, pkg: PackageName): PlannedCommand[] {
  if (!(layer in LAYER_SCRIPTS)) {
    throw new Error(`Invalid layer: ${String(layer)}. Expected one of unit, integration, e2e.`)
  }
  const targets = pkg === "all" ? PACKAGES.filter((p) => LAYER_SCRIPTS[layer][p]) : [pkg]
  const commands: PlannedCommand[] = []
  for (const target of targets) {
    if (!PACKAGES.includes(target)) {
      throw new Error(`Unknown package: ${String(target)}. Expected one of opencode, ellamaka-app, ellamaka-desktop.`)
    }
    const script = LAYER_SCRIPTS[layer][target]
    if (!script) {
      throw new Error(`Package ${target} has no ${layer} layer.`)
    }
    commands.push({ pkg: target, command: ["bun", "run", script] })
  }
  return commands
}

function packageDir(pkg: ConcretePackage): string {
  return join(import.meta.dir, "..", "packages", pkg)
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
      if (value === "opencode" || value === "ellamaka-app" || value === "ellamaka-desktop" || value === "all") {
        pkg = value
      } else {
        console.error(`Unknown package: ${value}. Expected one of opencode, ellamaka-app, ellamaka-desktop, all.`)
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
    console.error((err as Error).message)
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
  main()
}
