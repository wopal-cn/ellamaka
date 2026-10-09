import { existsSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runBunPtcChildIfRequested } from "../../src/runtime/bun-ptc-child"

if (!(await runBunPtcChildIfRequested())) {
  const anchor = process.env.ELLAMAKA_PTC_TEST_ANCHOR
  if (!anchor) throw new Error("ELLAMAKA_PTC_TEST_ANCHOR is required")
  const { createDshRuntimeApi } = await import("../../src/runtime/loader")
  const { bootDshWeb } = await import("../../src/dsh-web")
  const home = mkdtempSync(join(tmpdir(), "ellamaka-bun-ptc-home-"))
  const workspace = mkdtempSync(join(tmpdir(), "ellamaka-bun-ptc-workspace-"))
  const outside = mkdtempSync(join(tmpdir(), "ellamaka-bun-ptc-outside-"))
  const runtime = createDshRuntimeApi(anchor)
  const host = await bootDshWeb({ home, port: 0, installAnchor: anchor, runtime })
  try {
    const ptc = host.ctx.get("ptcRuntime")
    if (!ptc) throw new Error("ptcRuntime missing")

    const typed = await ptc.run(
      ptc.resolve({
        program: "const answer: number = 6 * 7; return { answer };",
        bindings: [],
        cwd: workspace,
        sandboxPolicy: { mode: "danger-full-access", workspaceRoot: workspace },
      }),
    )

    const staticImport = await ptc.run(
      ptc.resolve({
        program: 'import { readdir } from "node:fs/promises"; return typeof readdir;',
        bindings: [],
        cwd: workspace,
        sandboxPolicy: { mode: "danger-full-access", workspaceRoot: workspace },
      }),
    )

    const allowedPath = join(workspace, "allowed.txt")
    const allowed = await ptc.run(
      ptc.resolve({
        program: `const fs = await import("node:fs/promises"); await fs.writeFile(${JSON.stringify(allowedPath)}, "ok"); return { wrote: true };`,
        bindings: [],
        cwd: workspace,
        sandboxPolicy: { mode: "workspace-write", workspaceRoot: workspace },
      }),
    )

    const deniedPath = join(outside, "blocked.txt")
    const denied = await ptc.run(
      ptc.resolve({
        program: `const fs = await import("node:fs/promises"); await fs.writeFile(${JSON.stringify(deniedPath)}, "blocked"); return { wrote: true };`,
        bindings: [],
        cwd: workspace,
        sandboxPolicy: { mode: "read-only", workspaceRoot: workspace },
      }),
    )

    const stress = []
    for (let i = 0; i < 8; i += 1) {
      stress.push(
        await ptc.run(
          ptc.resolve({
            program: `const value: number = ${i}; return { value };`,
            bindings: [],
            cwd: workspace,
            sandboxPolicy: { mode: "danger-full-access", workspaceRoot: workspace },
          }),
        ),
      )
    }

    const controller = new AbortController()
    setTimeout(() => controller.abort("probe abort"), 100)
    const aborted = await ptc.run(
      ptc.resolve({
        program: "while (true) {}",
        bindings: [],
        cwd: workspace,
        sandboxPolicy: { mode: "danger-full-access", workspaceRoot: workspace },
        signal: controller.signal,
        timeoutMs: 5_000,
      }),
    )

    console.log(
      `__PTC_PROBE__${JSON.stringify({
        language: ptc.language,
        isolation: ptc.isolation,
        typed,
        staticImport,
        allowed,
        allowedExists: existsSync(allowedPath),
        denied,
        deniedExists: existsSync(deniedPath),
        stress,
        aborted,
      })}`,
    )
  } finally {
    await host.dispose()
  }
}
