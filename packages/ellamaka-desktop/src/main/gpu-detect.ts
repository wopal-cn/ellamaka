// VMware virtual GPU detection. On Windows VMs (VMware SVGA 3D) the GPU
// compositor never completes the first frame, so `ready-to-show` never fires
// and the window stays hidden. Detecting the virtual GPU lets the app disable
// hardware acceleration before any window is created. Fail-open: any detection
// error returns false and never blocks startup.

import { execFileSync } from "node:child_process"

export type WmicExec = (command: string, args: string[], options: { timeout: number }) => string

const defaultWmicExec: WmicExec = (command, args, options) => execFileSync(command, args, options).toString()

export function isVmwareVirtualGpu(
  platform: NodeJS.Platform = process.platform,
  exec: WmicExec = defaultWmicExec,
): boolean {
  if (platform !== "win32") return false
  try {
    const output = exec("wmic", ["path", "win32_videocontroller", "get", "name"], { timeout: 5000 })
    return output.toLowerCase().includes("vmware")
  } catch {
    return false
  }
}
