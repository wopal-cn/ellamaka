export type ChatFollowState = "following" | "paused"
export type ChatFollowTransition = "resume" | "pause"

export const initialChatFollowState: ChatFollowState = "following"

/** The explicit latest-message intent is owned by the Workbench chat panel. */
export function transitionChatFollowState(_state: ChatFollowState, transition: ChatFollowTransition): ChatFollowState {
  return transition === "resume" ? "following" : "paused"
}

export function shouldKeepChatAtLatest(state: ChatFollowState): boolean {
  return state === "following"
}

export function shouldRestoreChatFollowAfterCompletion(input: {
  previousWorking: boolean | undefined
  working: boolean
  state: ChatFollowState
}): boolean {
  return input.previousWorking === true && !input.working && shouldKeepChatAtLatest(input.state)
}
