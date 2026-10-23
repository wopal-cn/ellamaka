import { createRequire } from "node:module"
import { inspect } from "node:util"
import "../../src/runtime/preload"
import { runBunPtcChildIfRequested } from "../../src/runtime/bun-ptc-child"

const gcAnchor = process.env.ELLAMAKA_SUBPROCESS_GC_ANCHOR
if (gcAnchor) {
  const koffi = createRequire(gcAnchor)("koffi")
  function releaseLibrary() {
    const library =
      process.platform === "darwin"
        ? "/usr/lib/libSystem.B.dylib"
        : process.platform === "win32"
          ? "kernel32.dll"
          : "libc.so.6"
    const lib = koffi.load(library)
    lib.func(process.platform === "win32" ? "uint32_t __stdcall GetCurrentProcessId(void)" : "int dup(int)")
  }
  releaseLibrary()
  Bun.gc(true)
  await Bun.sleep(0)
  Bun.gc(true)
}

const originalArgv = [...process.argv]
try {
  const handled = await runBunPtcChildIfRequested()
  console.log(
    "__BOOTSTRAP__" +
      JSON.stringify({
        handled,
        originalArgv,
        argv: process.argv,
        execPath: process.execPath,
        selection: process.env.DSH_SUBPROCESS_RUNNER ?? null,
        ptcMarker: process.env.DSH_PTC_RUNTIME_NODE ?? null,
      }),
  )
} catch (error) {
  console.error(error instanceof Error ? error.message : inspect(error))
  process.exitCode = 1
}
