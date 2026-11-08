import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Bus } from "../../src/bus"
import { Config } from "../../src/config/config"
import { Plugin } from "../../src/plugin"
import { Pty } from "../../src/pty"
import { Duration, Effect, Layer, Queue } from "effect"
import { testEffect } from "../lib/effect"
import { TestInstance } from "../fixture/fixture"
import { ptyAvailable } from "../fixture/pty"
import { scopedEnv } from "../fixture/process-env"

type Socket = Parameters<Pty.Interface["connect"]>[1]

const it = testEffect(
  Pty.layer.pipe(
    Layer.provideMerge(Bus.layer),
    Layer.provideMerge(Config.defaultLayer),
    Layer.provideMerge(Plugin.defaultLayer),
  ),
)
const ptyTest = process.platform === "win32" || !ptyAvailable() ? it.instance.skip : it.instance

const createPty = Effect.fn("PtyEnvTest.createPty")(function* (input: Pty.CreateInput) {
  const pty = yield* Pty.Service
  return yield* Effect.acquireRelease(pty.create(input), (info) => pty.remove(info.id).pipe(Effect.ignore))
})

const decodeOutput = (data: string | Uint8Array | ArrayBuffer) =>
  typeof data === "string"
    ? data
    : Buffer.from(data instanceof Uint8Array ? data : new Uint8Array(data)).toString("utf8")

const makeSocket = Effect.fn("PtyEnvTest.makeSocket")(function* (data: unknown) {
  const output = yield* Queue.unbounded<string>()
  const socket: Socket = {
    readyState: 1,
    data,
    send: (data) => {
      Queue.offerUnsafe(output, decodeOutput(data))
    },
    close: () => {},
  }
  return { socket, output }
})

const waitForOutput = (output: Queue.Queue<string>, text: string, duration: Duration.Input = "5 seconds") =>
  Effect.gen(function* () {
    let received = ""
    while (!received.includes(text)) {
      received += yield* Queue.take(output)
    }
    return received
  }).pipe(
    Effect.timeoutOrElse({
      duration,
      orElse: () => Effect.fail(new Error(`timeout waiting for output containing ${JSON.stringify(text)}`)),
    }),
  )

// Fixture-owned identities only: the sentinel tool and the marker value live
// inside this test's temp directory, so a passing assertion cannot come from the
// developer PATH or from any real user environment.
const SENTINEL_NAME = "ellamaka-263-pty-sentinel"
const SENTINEL_OUTPUT = "WOPAL_263_PTY_SENTINEL_RAN"
const HOST_MARKER = "WOPAL_263_PTY_HOST_MARKER"
const HOST_MARKER_VALUE = "host-marker-263"

describe("pty env", () => {
  ptyTest(
    "injects COLORTERM=truecolor while keeping TERM=xterm-256color",
    () =>
      Effect.gen(function* () {
        const pty = yield* Pty.Service
        const p = yield* createPty({
          command: "sh",
          args: ["-c", 'printf \'COLORTERM=%s TERM=%s\' "$COLORTERM" "$TERM"'],
          title: "env",
        })
        const out = yield* makeSocket({ events: { connection: "env" } })
        yield* pty.connect(p.id, out.socket)
        const received = yield* waitForOutput(out.output, "TERM=")
        expect(received).toContain("COLORTERM=truecolor")
        expect(received).toContain("TERM=xterm-256color")
      }),
    { git: true },
  )

  ptyTest(
    "fixed COLORTERM entry overrides an inherited conflicting value",
    () =>
      Effect.gen(function* () {
        yield* Effect.acquireUseRelease(
          Effect.sync(() => scopedEnv({ COLORTERM: "8bit" })),
          () =>
            Effect.gen(function* () {
              const pty = yield* Pty.Service
              const p = yield* createPty({
                command: "sh",
                args: ["-c", "printf 'COLORTERM=%s' \"$COLORTERM\""],
                title: "env-override",
              })
              const out = yield* makeSocket({ events: { connection: "env-override" } })
              yield* pty.connect(p.id, out.socket)
              const received = yield* waitForOutput(out.output, "COLORTERM=")
              expect(received).toContain("COLORTERM=truecolor")
            }),
          (scope) => Effect.sync(() => scope[Symbol.dispose]()),
        )
      }),
    { git: true },
  )

  // #263 evidence at the Native PTY boundary: the environment the sidecar hands
  // to the Runtime must reach a real forkpty child, not just an env helper.
  // PATH is replaced wholesale so the sentinel is only reachable through the
  // injected value; a passing run therefore cannot be an accident of the
  // developer's own PATH.
  ptyTest("runs a PATH sentinel tool from the inherited parent environment in a real PTY child", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const bin = path.join(test.directory, "sentinel-bin")
      const tool = path.join(bin, SENTINEL_NAME)
      const isolatedPath = `${bin}:/usr/bin:/bin`
      yield* Effect.promise(async () => {
        await fs.mkdir(bin, { recursive: true })
        await Bun.write(tool, "#!/bin/sh\nprintf '%s' " + JSON.stringify(SENTINEL_OUTPUT) + "\n")
        await fs.chmod(tool, 0o755)
      })

      const script = [
        "printf 'PATH=%s\\n' \"$PATH\"",
        `printf 'RESOLVED=%s\\n' "$(command -v ${SENTINEL_NAME} || printf MISSING)"`,
        "printf 'MARKER=%s\\n' \"$" + HOST_MARKER + '"',
        `${SENTINEL_NAME} || printf 'SENTINEL_FAILED\\n'`,
        "printf 'DONE\\n'",
      ].join("; ")

      const received = yield* Effect.acquireUseRelease(
        Effect.sync(() => scopedEnv({ PATH: isolatedPath, [HOST_MARKER]: HOST_MARKER_VALUE })),
        () =>
          Effect.gen(function* () {
            const pty = yield* Pty.Service
            const p = yield* createPty({ command: "sh", args: ["-c", script], title: "host-env" })
            const out = yield* makeSocket({ events: { connection: "host-env" } })
            yield* pty.connect(p.id, out.socket)
            return yield* waitForOutput(out.output, "DONE")
          }),
        (scope) => Effect.sync(() => scope[Symbol.dispose]()),
      )

      // The child reports its own PATH, so this compares the real PTY
      // environment against the isolated value instead of our intent.
      expect(received).toContain(`PATH=${isolatedPath}`)
      expect(received).toContain(`RESOLVED=${tool}`)
      expect(received).toContain(`MARKER=${HOST_MARKER_VALUE}`)
      expect(received).toContain(SENTINEL_OUTPUT)
      expect(received).not.toContain("SENTINEL_FAILED")
    }),
  )
})
