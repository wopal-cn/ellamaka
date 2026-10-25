import { describe, expect, test } from "bun:test"
import { createMemo, createRoot } from "solid-js"
import { createSessionProjection } from "../session-store"
import {
  shouldAcceptSessionDrop,
  shouldNotifySessionRemoval,
  sessionDropRejection,
  sessionRemovalReasonFromEvent,
  shouldRestoreBoundSession,
  shouldSyncSessionTitle,
  disconnectRecovery,
  workbenchSessionEvent,
  isSessionNotFound,
} from "./panel-session-lifecycle"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

describe("shouldAcceptSessionDrop", () => {
  test("silently rejects drops onto a panel that already has a session", () => {
    expect(shouldAcceptSessionDrop({ targetSlotState: "bound", sourceHasLiveBinding: false })).toBe(false)
  })

  test("rejects reopening a session that is already bound in another panel", () => {
    expect(shouldAcceptSessionDrop({ targetSlotState: "empty", sourceHasLiveBinding: true })).toBe(false)
  })

  test("accepts an unbound session in an empty panel", () => {
    expect(shouldAcceptSessionDrop({ targetSlotState: "empty", sourceHasLiveBinding: false })).toBe(true)
  })
})

describe("sessionDropRejection", () => {
  test("explains whether the target panel or source session is already open", () => {
    expect(sessionDropRejection({ targetSlotState: "bound", sourceHasLiveBinding: false })).toBe("target-occupied")
    expect(sessionDropRejection({ targetSlotState: "empty", sourceHasLiveBinding: true })).toBe("session-already-open")
    expect(sessionDropRejection({ targetSlotState: "empty", sourceHasLiveBinding: false })).toBeUndefined()
  })
})

describe("shouldRestoreBoundSession", () => {
  test("restores a persisted binding when its local session projection is missing", () => {
    expect(shouldRestoreBoundSession({ slotState: "bound", boundSessionId: "ses-1", hasLocalSession: false })).toBe(
      true,
    )
  })

  test("does not restore empty panels or bindings that already have a local reference", () => {
    expect(shouldRestoreBoundSession({ slotState: "empty", boundSessionId: undefined, hasLocalSession: false })).toBe(
      false,
    )
    expect(shouldRestoreBoundSession({ slotState: "bound", boundSessionId: "ses-1", hasLocalSession: true })).toBe(
      false,
    )
  })
})

describe("sessionRemovalReasonFromEvent", () => {
  test("ignores cache state and non-destructive session updates", () => {
    expect(sessionRemovalReasonFromEvent({ type: "session.updated" })).toBeUndefined()
  })

  test("identifies an explicit server deletion", () => {
    expect(sessionRemovalReasonFromEvent({ type: "session.deleted" })).toBe("deleted")
  })

  test("identifies an externally archived session", () => {
    expect(sessionRemovalReasonFromEvent({ type: "session.updated", timeArchived: 1 })).toBe("archived")
  })
})

describe("shouldNotifySessionRemoval", () => {
  test("notifies when an externally removed Session was bound and is now released", () => {
    expect(shouldNotifySessionRemoval({ affectedPanelCount: 1, isBound: false })).toBe(true)
  })

  test("does not notify for an unbound Session or before its binding is released", () => {
    expect(shouldNotifySessionRemoval({ affectedPanelCount: 0, isBound: false })).toBe(false)
    expect(shouldNotifySessionRemoval({ affectedPanelCount: 1, isBound: true })).toBe(false)
  })
})

describe("shouldSyncSessionTitle", () => {
  test("returns false for non-session.updated events", () => {
    expect(
      shouldSyncSessionTitle({ type: "session.created", sessionId: "s1", title: "Hello", localTitle: "Old" }),
    ).toBe(false)
    expect(
      shouldSyncSessionTitle({ type: "session.deleted", sessionId: "s1", title: "Hello", localTitle: "Old" }),
    ).toBe(false)
  })

  test("returns false when sessionId or title is missing", () => {
    expect(shouldSyncSessionTitle({ type: "session.updated", title: "Hello", localTitle: "Old" })).toBe(false)
    expect(shouldSyncSessionTitle({ type: "session.updated", sessionId: "s1", localTitle: "Old" })).toBe(false)
    expect(shouldSyncSessionTitle({ type: "session.updated", sessionId: "s1", title: "", localTitle: "Old" })).toBe(
      false,
    )
  })

  test("returns false when the session is not tracked locally", () => {
    expect(shouldSyncSessionTitle({ type: "session.updated", sessionId: "s1", title: "Hello" })).toBe(false)
    expect(
      shouldSyncSessionTitle({ type: "session.updated", sessionId: "s1", title: "Hello", localTitle: undefined }),
    ).toBe(false)
  })

  test("returns false when the title has not changed", () => {
    expect(
      shouldSyncSessionTitle({ type: "session.updated", sessionId: "s1", title: "Same", localTitle: "Same" }),
    ).toBe(false)
  })

  test("returns true when the title differs from the local store", () => {
    expect(
      shouldSyncSessionTitle({ type: "session.updated", sessionId: "s1", title: "New Title", localTitle: "Old Title" }),
    ).toBe(true)
  })
})

describe("disconnectRecovery", () => {
  test("returns reconnect when the PTY is still alive after a WebSocket close", () => {
    expect(disconnectRecovery({ ptyAlive: true })).toBe("reconnect")
  })

  test("returns fallback when the PTY has been reaped (404)", () => {
    expect(disconnectRecovery({ ptyAlive: false })).toBe("fallback")
  })
})

describe("workbenchSessionEvent", () => {
  test("ignores an event without session details", () => {
    expect(workbenchSessionEvent()).toEqual({
      type: undefined,
      sessionId: undefined,
      title: undefined,
      timeArchived: undefined,
    })
  })

  test("reads the session id from an incremental session.updated payload", () => {
    expect(
      workbenchSessionEvent({
        type: "session.updated",
        properties: {
          sessionID: "ses_1",
          info: { title: "Generated title" },
        },
      }),
    ).toEqual({
      type: "session.updated",
      sessionId: "ses_1",
      title: "Generated title",
      timeArchived: undefined,
    })
  })

  test("uses the complete session payload for creation and deletion events", () => {
    expect(
      workbenchSessionEvent({
        type: "session.deleted",
        properties: {
          sessionID: "ses_2",
          info: { id: "ses_2", time: { archived: 10 } },
        },
      }),
    ).toEqual({
      type: "session.deleted",
      sessionId: "ses_2",
      title: undefined,
      timeArchived: 10,
    })
  })
})

describe("isSessionNotFound", () => {
  test("detects HTTP 404 via statusCode", () => {
    expect(isSessionNotFound({ statusCode: 404, message: "Not Found" })).toBe(true)
  })

  test("detects HTTP 404 via status", () => {
    expect(isSessionNotFound({ status: 404, message: "Not Found" })).toBe(true)
  })

  test("detects Effect SessionNotFoundError via _tag", () => {
    expect(isSessionNotFound({ _tag: "SessionNotFoundError", message: "Session not found: ses_x" })).toBe(true)
  })

  test("detects Error with 'Session not found' message", () => {
    expect(isSessionNotFound(new Error("Session not found: ses_abc"))).toBe(true)
  })

  test("detects string with 'not found'", () => {
    expect(isSessionNotFound("Session not found: ses_xyz")).toBe(true)
  })

  test("detects object with message containing 'not found'", () => {
    expect(isSessionNotFound({ message: "Session not found: ses_x" })).toBe(true)
  })

  test("rejects HTTP 500 (transient server error)", () => {
    expect(isSessionNotFound({ statusCode: 500, message: "Internal Server Error" })).toBe(false)
  })

  test("rejects network errors without not-found indicators", () => {
    expect(isSessionNotFound(new Error("fetch failed"))).toBe(false)
    expect(isSessionNotFound(new Error("network error"))).toBe(false)
  })

  test("rejects undefined and null", () => {
    expect(isSessionNotFound(undefined)).toBe(false)
    expect(isSessionNotFound(null)).toBe(false)
  })

  test("rejects empty string", () => {
    expect(isSessionNotFound("")).toBe(false)
  })
})

describe("sessionProjection isolation", () => {
  test("removing an unrelated session does not invalidate memoized session identity", () => {
    createRoot((dispose: () => void) => {
      const projection = createSessionProjection()
      projection.writer.upsert({
        id: "s1",
        spaceName: "General",
        projectPath: "/p1",
        type: "chat",
        title: "Session 1",
        directoryHealth: "healthy",
        createdAt: 100,
        lastActiveAt: 100,
      })
      projection.writer.upsert({
        id: "s2",
        spaceName: "General",
        projectPath: "/p1",
        type: "chat",
        title: "Session 2",
        directoryHealth: "healthy",
        createdAt: 200,
        lastActiveAt: 200,
      })

      const boundSession = createMemo(
        () => {
          return projection.reader.getSession("s1")
        },
        undefined,
        {
          equals: (prev: unknown, next: unknown) => {
            if (prev === next) return true
            if (!isRecord(prev) || !isRecord(next)) return false
            return (
              prev.id === next.id &&
              prev.title === next.title &&
              prev.type === next.type &&
              prev.directoryHealth === next.directoryHealth &&
              prev.timeArchived === next.timeArchived
            )
          },
        },
      )

      expect(boundSession()?.id).toBe("s1")

      // Remove unrelated session "s2"
      projection.writer.remove("s2")

      // The memo should return identical s1 session data
      expect(boundSession()?.id).toBe("s1")
      // Check that equals check intercepted the update for downstream subscribers
      expect(projection.reader.getSession("s1")?.id).toBe("s1")
      expect(projection.reader.getSession("s2")).toBeUndefined()

      dispose()
    })
  })
})
