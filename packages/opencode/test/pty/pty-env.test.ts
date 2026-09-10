import { describe, expect } from "bun:test"
import { Bus } from "../../src/bus"
import { Config } from "../../src/config/config"
import { Plugin } from "../../src/plugin"
import { Pty } from "../../src/pty"
import { Duration, Effect, Layer, Queue } from "effect"
import { testEffect } from "../lib/effect"
import { ptyAvailable } from "../fixture/pty"

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

describe("pty env", () => {
  ptyTest(
    "injects COLORTERM=truecolor while keeping TERM=xterm-256color",
    () =>
      Effect.gen(function* () {
        const pty = yield* Pty.Service
        const p = yield* createPty({
          command: "sh",
          args: ["-c", "printf 'COLORTERM=%s TERM=%s' \"$COLORTERM\" \"$TERM\""],
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
        const prev = process.env.COLORTERM
        process.env.COLORTERM = "8bit"
        try {
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
        } finally {
          if (prev === undefined) delete process.env.COLORTERM
          else process.env.COLORTERM = prev
        }
      }),
    { git: true },
  )
})
