import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { cliIt } from "../lib/cli-process"
import { BINARY_NAME } from "@wopal/ellamaka-brand/branding"

describe("ellamaka --version output", () => {
  cliIt.live(
    "prints bare version without brand prefix",
    ({ opencode }) =>
      Effect.gen(function* () {
        const result = yield* opencode.spawn(["--version"])
        opencode.expectExit(result, 0, "version")

        // yargs writes --version output to stdout. The version string must be
        // the bare InstallationVersion (e.g. "1.15.13") with no brand prefix —
        // matching upstream opencode exactly so users/tooling that parses the
        // version don't have to strip an ellamaka/ prefix.
        const out = (result.stdout || "").trim()
        const err = (result.stderr || "").trim()
        const text = out || err

        expect(text.length).toBeGreaterThan(0)
        // Must NOT contain a brand prefix like "ellamaka/". The version string
        // should be the bare InstallationVersion (a semver in releases, or
        // "local" in dev/test builds) — never "ellamaka/<version>".
        expect(text).not.toContain(`${BINARY_NAME}/`)
        expect(text).not.toMatch(/^[A-Za-z][A-Za-z0-9_-]*\//)
      }),
    30_000,
  )
})