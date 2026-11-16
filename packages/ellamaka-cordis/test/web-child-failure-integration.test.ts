import { expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { prepareDshHome } from "../src/runtime/home-guard"
import { DEFAULT_DSH_RUNTIME_MANIFEST } from "../src/runtime/manager"
import { prepareDshProfiles } from "./fixture/prepare-dsh-profiles"

test("a broken required Web service exits nonzero rather than reporting a successful shutdown", async () => {
  const wopalHome = mkdtempSync(join(tmpdir(), "web-child-invalid-core-"))
  const home = join(wopalHome, "dsh")
  const prepared = await prepareDshHome({ wopalHome, closureVersion: DEFAULT_DSH_RUNTIME_MANIFEST.closureVersion })
  expect(prepared.ok).toBe(true)
  prepareDshProfiles(home)
  writeFileSync(
    join(home, "home", "profiles", "web", "cordis.patch.yml"),
    "- id: agent-preset-registry\n  disabled: true\n",
  )

  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "fixtures", "web-child-entry.ts"),
      "--ellamaka-dsh-web-child",
      "--home",
      home,
      "--port",
      "0",
      "--disable-ptc-runtime",
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "pipe",
      env: { ...process.env, ELLAMAKA_DSH_TOOLS: "1" },
    },
  )

  expect(await child.exited).not.toBe(0)
  expect(await new Response(child.stdout).text()).not.toContain('"ready":true')
  expect(await new Response(child.stderr).text()).toContain("dsh web child boot failed")
}, 30_000)
