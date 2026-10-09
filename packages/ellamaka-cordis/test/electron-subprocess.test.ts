import { expect, test } from "bun:test"
import type { SubprocessSpawnSpec } from "@deepseek-ai/dsh-subprocess"
import { electronPtcSpawnSpec } from "../src/runtime/electron-subprocess"

test("Electron's Node mode is limited to its official PTC bootstrap, including confined argv", () => {
  const spec: SubprocessSpawnSpec = {
    argv: [
      "/usr/bin/sandbox-exec",
      "-p",
      "policy",
      "/app/Ellamaka",
      "--max-old-space-size=128",
      "/closure/lib/process.js",
      "256",
    ],
    cwd: "/workspace",
    env: { TOKEN: undefined },
    stdio: { stdin: "ignore", stdout: "pipe", stderr: "pipe", control: "pipe" },
    graceMs: 100,
  }
  const changed = electronPtcSpawnSpec(spec, "/app/Ellamaka", "/closure/lib/process.js")
  expect(changed.env).toEqual({ TOKEN: undefined, ELECTRON_RUN_AS_NODE: "1" })
  expect(changed.argv).toBe(spec.argv)
  expect(spec.env).toEqual({ TOKEN: undefined })
  expect(
    electronPtcSpawnSpec({ ...spec, argv: ["/bin/sh", "-c", "something"] }, "/app/Ellamaka", "/closure/lib/process.js"),
  ).toBeDefined()
  expect(electronPtcSpawnSpec(spec, "/other/Electron", "/closure/lib/process.js")).toBe(spec)
  expect(
    electronPtcSpawnSpec(
      { ...spec, stdio: { ...spec.stdio, control: undefined } },
      "/app/Ellamaka",
      "/closure/lib/process.js",
    ).env,
  ).toBe(spec.env)
})
