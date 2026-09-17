import { describe, expect, test } from "bun:test"
import { join } from "node:path"

// Unit tests for scripts/lib/release.sh helpers. The lib is sourced in a
// fresh bash subprocess per case (top-level `set -euo pipefail` + globals)
// so tests cannot pollute the bun process.

const REPO_ROOT = join(import.meta.dir, "../..")

function runLib(snippet: string, env: Record<string, string>): string {
  const exports = Object.entries(env)
    .map(([k, v]) => `export ${k}=${JSON.stringify(v)}`)
    .join("\n")
  const script = `
    set -euo pipefail
    ${exports}
    export REPO_ROOT=${JSON.stringify(REPO_ROOT)}
    source "$REPO_ROOT/scripts/lib/release.sh" >/dev/null 2>&1
    ${snippet}
  `
  const proc = Bun.spawnSync(["bash", "-c", script])
  if (proc.exitCode !== 0) {
    throw new Error(`lib snippet failed: ${proc.stderr.toString().trim()}`)
  }
  return proc.stdout.toString().trim()
}

describe("release.sh manifest_url", () => {
  test("CLI product resolves the ellamaka/ versioned path", () => {
    const url = runLib('manifest_url "2.0.5-rc.6"', { PRODUCT: "ellamaka-cli" })
    expect(url).toBe("https://download.coursedao.com/ellamaka/v2.0.5-rc.6/manifest.json")
  })

  test("desktop stable resolves the ellamaka-desktop/ versioned path", () => {
    const url = runLib('manifest_url "2.0.6"', { PRODUCT: "ellamaka-desktop", CHANNEL: "stable" })
    expect(url).toBe("https://download.coursedao.com/ellamaka-desktop/v2.0.6/manifest.json")
  })

  test("desktop beta resolves the ellamaka-desktop/beta/ versioned path", () => {
    const url = runLib('manifest_url "2.0.5-beta.1"', { PRODUCT: "ellamaka-desktop", CHANNEL: "beta" })
    expect(url).toBe("https://download.coursedao.com/ellamaka-desktop/beta/v2.0.5-beta.1/manifest.json")
  })

  test("desktop defaults to the stable root when CHANNEL is unset", () => {
    const url = runLib('manifest_url "2.0.6"', { PRODUCT: "ellamaka-desktop" })
    expect(url).toBe("https://download.coursedao.com/ellamaka-desktop/v2.0.6/manifest.json")
  })
})

describe("release.sh bump_commit_subject", () => {
  test("CLI rc carries the product and version without channel suffix", () => {
    const subject = runLib("bump_commit_subject", {
      PRODUCT: "ellamaka-cli",
      VERSION: "2.0.5-rc.6",
      CHANNEL_LABEL: "stable",
    })
    expect(subject).toBe("chore(release): bump ellamaka-cli to 2.0.5-rc.6")
  })

  test("desktop stable has no channel suffix", () => {
    const subject = runLib("bump_commit_subject", {
      PRODUCT: "ellamaka-desktop",
      VERSION: "2.0.6",
      CHANNEL_LABEL: "stable",
    })
    expect(subject).toBe("chore(release): bump ellamaka-desktop to 2.0.6")
  })

  test("desktop beta is annotated with the channel", () => {
    const subject = runLib("bump_commit_subject", {
      PRODUCT: "ellamaka-desktop",
      VERSION: "2.0.5-beta.1",
      CHANNEL_LABEL: "beta",
    })
    expect(subject).toBe("chore(release): bump ellamaka-desktop to 2.0.5-beta.1 (beta)")
  })
})

describe("build.sh release channel guard", () => {
  test("the CLI channel export is skipped in release mode", async () => {
    const buildSh = await Bun.file(join(REPO_ROOT, "scripts/build.sh")).text()
    // build-env (D-03) derives the release channel from the version shape and
    // fail-closes on contradiction; exporting the dev default ("main") broke
    // every CLI release build.
    expect(buildSh).toMatch(
      /if \[\[ -z "\$\{ELLAMAKA_RELEASE:-\}" \]\]; then\n\s*export ELLAMAKA_CHANNEL="\$CHANNEL"/,
    )
  })
})
