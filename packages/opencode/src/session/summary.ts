import { Effect, Layer, Context } from "effect"
import * as Session from "./session"
import { SessionID, MessageID } from "./schema"

export interface Interface {
  readonly summarize: (input: { sessionID: SessionID; messageID: MessageID }) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionSummary") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service

    const summarize = Effect.fn("SessionSummary.summarize")(function* (input: {
      sessionID: SessionID
      messageID: MessageID
    }) {
      const all = yield* sessions.messages({ sessionID: input.sessionID }).pipe(Effect.orDie)
      if (!all.length) return

      // The git-snapshot diff computation was removed; summaries now track
      // zero deltas. Kept so historical sessions keep a summary shape.
      yield* sessions.setSummary({
        sessionID: input.sessionID,
        summary: {
          additions: 0,
          deletions: 0,
          files: 0,
        },
      })

      const messages = all.filter(
        (m) => m.info.id === input.messageID || (m.info.role === "assistant" && m.info.parentID === input.messageID),
      )
      const target = messages.find((m) => m.info.id === input.messageID)
      if (!target || target.info.role !== "user") return
      target.info.summary = { ...target.info.summary, diffs: [] }
      yield* sessions.updateMessage(target.info)
    })

    return Service.of({ summarize })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Session.defaultLayer),
  ),
)

export * as SessionSummary from "./summary"
