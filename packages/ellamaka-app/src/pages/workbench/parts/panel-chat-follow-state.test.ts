import { describe, expect, test } from "bun:test"
import {
  initialChatFollowState,
  shouldRestoreChatFollowAfterCompletion,
  transitionChatFollowState,
  shouldKeepChatAtLatest,
} from "./panel-chat-follow-state"

describe("Workbench chat follow state", () => {
  test("keeps the latest message pinned when a following session completes", () => {
    const following = transitionChatFollowState(initialChatFollowState, "resume")

    expect(shouldKeepChatAtLatest(following)).toBe(true)
    expect(shouldRestoreChatFollowAfterCompletion({ previousWorking: true, working: false, state: following })).toBe(
      true,
    )
  })

  test("preserves a user-selected reading position across completion", () => {
    const paused = transitionChatFollowState(initialChatFollowState, "pause")

    expect(shouldKeepChatAtLatest(paused)).toBe(false)
    expect(shouldRestoreChatFollowAfterCompletion({ previousWorking: true, working: false, state: paused })).toBe(false)
  })

  test("treats transcript navigation as pause and End or the resume action as follow", () => {
    const paused = transitionChatFollowState(initialChatFollowState, "pause")
    const resumed = transitionChatFollowState(paused, "resume")

    expect(paused).toBe("paused")
    expect(resumed).toBe("following")
    expect(shouldRestoreChatFollowAfterCompletion({ previousWorking: false, working: false, state: resumed })).toBe(
      false,
    )
  })
})
