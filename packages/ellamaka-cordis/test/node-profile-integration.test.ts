import { expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

// Bun cannot exercise the official HostResolvedRootInclude's internal-loader branch.
test("Node mounts profile-local plugin exports and replays their configuration", async () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-node-profile-"))
  try {
    const require = createRequire(import.meta.url)
    const anchor = require.resolve("@deepseek-ai/dsh/package.json")
    const external = ["../package.json", "../../ellamaka-core/package.json"]
      .flatMap((file) => Object.keys(JSON.parse(readFileSync(join(import.meta.dir, file), "utf8")).dependencies))
      .filter((name) => !name.startsWith("@wopal/") && name !== "@npmcli/config")
    const build = await Bun.build({
      entrypoints: ["../src/dsh-web.ts", "../src/runtime/loader.ts", "../src/runtime/profile-resources.ts"].map(
        (file) => join(import.meta.dir, file),
      ),
      target: "node",
      format: "esm",
      external,
      outdir: root,
    })
    expect(build.success).toBe(true)
    writeFileSync(join(root, "package.json"), '{"type":"module"}')
    // External dependencies resolve from the same workspace as this package.
    const { symlinkSync } = await import("node:fs")
    symlinkSync(join(import.meta.dir, "../../../node_modules"), join(root, "node_modules"), "dir")
    const home = join(root, "dsh")
    const dir = join(home, "home/profiles/ellamaka-tools")
    const plugin = join(dir, "node_modules/fixture-node-plugin")
    mkdirSync(plugin, { recursive: true })
    writeFileSync(
      join(plugin, "package.json"),
      JSON.stringify({
        name: "fixture-node-plugin",
        version: "1.0.0",
        type: "module",
        exports: { ".": { import: "./index.js" }, "./sub": { import: "./sub.js" } },
      }),
    )
    writeFileSync(
      join(plugin, "index.js"),
      "export function apply(ctx, config) { ctx.provide('nodeProfileValue', config.value) }",
    )
    writeFileSync(join(plugin, "sub.js"), "export function apply(ctx) { ctx.provide('nodeProfileSubpath', true) }")
    const script = join(root, "probe.mjs")
    writeFileSync(
      script,
      `
      import assert from 'node:assert/strict';
      import { readFileSync, writeFileSync } from 'node:fs';
      import { createDshRuntimeApi } from ${JSON.stringify(pathToFileURL(join(root, "runtime/loader.js")).href)};
      import { prepareDshProfileResourcesAtRoot } from './runtime/profile-resources.js';
      import { bootDshTools, verifyDshToolsRegistered } from './dsh-web.js';
      const home = ${JSON.stringify(home)};
      const anchor = ${JSON.stringify(anchor)};
      const runtime = createDshRuntimeApi(anchor);
      prepareDshProfileResourcesAtRoot(home, runtime);
      const patch = ${JSON.stringify(join(dir, "cordis.patch.yml"))};
      writeFileSync(patch, readFileSync(patch, 'utf8') + '\\n- insert:\\n    - id: node-extension\\n      name: fixture-node-plugin\\n      config:\\n        value: first\\n    - id: node-subpath\\n      name: fixture-node-plugin/sub\\n');
      const host = await bootDshTools({ home, port: 0, installAnchor: anchor, runtime, disablePtcRuntime: true });
      try {
        assert.equal(host.ctx.get('nodeProfileValue'), 'first');
        assert.equal(host.ctx.get('nodeProfileSubpath'), true);
        assert.ok(host.ctx.get('loader').internal, 'must exercise the real Node internal loader');
        verifyDshToolsRegistered(name => host.ctx.get(name, false));
        writeFileSync(patch, readFileSync(patch, 'utf8').replace('value: first', 'value: second'));
        const profile = runtime.appBoot.loadProfile('ellamaka', 'ellamaka-tools', anchor, home + '/home');
        await runtime.appBoot.reconcileProfilePatches(host.ctx, [...profile.layers.flatMap(layer => layer.patches), ...profile.patches], 'ellamaka');
        assert.equal(host.ctx.get('nodeProfileValue'), 'second');
        console.log('NODE_PROFILE_OK');
      } finally { await host.dispose(); }
    `,
    )
    const child = Bun.spawn(["node", "--expose-internals", script], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, WOPAL_HOME: join(root, "wopal-home") },
    })
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(exit, stderr + stdout).toBe(0)
    expect(stdout).toContain("NODE_PROFILE_OK")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 60_000)
