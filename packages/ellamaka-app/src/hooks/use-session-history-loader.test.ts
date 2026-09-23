import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { useSessionHistoryLoader } from "./use-session-history-loader"
import type { UserMessage } from "@wopal/ellamaka-sdk/v2/client"

function msg(id: string): UserMessage {
  return { id, role: "user" } as UserMessage
}

describe("useSessionHistoryLoader", () => {
  test("scroll near top triggers loadMore", async () => {
    let loadMoreCalled = false

    await createRoot(async (dispose) => {
      let sessionID = "s1"
      let loaded = 5
      let visible: UserMessage[] = [msg("m1"), msg("m2")]
      let more = true
      let loading = false
      let scrolled = true
      const scrollerEl = { scrollTop: 0 } as HTMLDivElement

      const loadMoreFn = async (id: string) => {
        loadMoreCalled = true
        loaded += 1
        visible = [msg("m0"), ...visible]
      }

      const hook = useSessionHistoryLoader({
        sessionID: () => sessionID,
        loaded: () => loaded,
        visibleUserMessages: () => visible,
        historyMore: () => more,
        historyLoading: () => loading,
        loadMore: loadMoreFn,
        userScrolled: () => scrolled,
        scroller: () => scrollerEl,
      })

      hook.onScrollerScroll()
      // fetchOlderMessages runs synchronously up to the first await;
      // loadMoreFn is async but has no internal await so it resolves immediately.
      // Still yield a microtask to let any continuations flush.
      await new Promise((r) => setTimeout(r, 0))
      dispose()
    })

    expect(loadMoreCalled).toBe(true)
  })

  test("loading in progress does not re-trigger", () => {
    let loadMoreCalled = false

    createRoot((dispose) => {
      let sessionID = "s1"
      let loaded = 5
      const visible: UserMessage[] = [msg("m1"), msg("m2")]
      let more = true
      let loading = true

      const loadMoreFn = async (_id: string) => {
        loadMoreCalled = true
      }

      const hook = useSessionHistoryLoader({
        sessionID: () => sessionID,
        loaded: () => loaded,
        visibleUserMessages: () => visible,
        historyMore: () => more,
        historyLoading: () => loading,
        loadMore: loadMoreFn,
        userScrolled: () => true,
        scroller: () => ({ scrollTop: 0 } as HTMLDivElement),
      })

      // loadAndReveal calls fetchOlderMessages which checks historyLoading()
      // synchronously and returns early — no async needed.
      hook.loadAndReveal()
      dispose()
    })

    expect(loadMoreCalled).toBe(false)
  })

  test("no more data stops calling loadMore", () => {
    let loadMoreCalled = false

    createRoot((dispose) => {
      let sessionID = "s1"
      let loaded = 5
      const visible: UserMessage[] = [msg("m1"), msg("m2")]
      let more = false
      let loading = false

      const loadMoreFn = async (_id: string) => {
        loadMoreCalled = true
      }

      const hook = useSessionHistoryLoader({
        sessionID: () => sessionID,
        loaded: () => loaded,
        visibleUserMessages: () => visible,
        historyMore: () => more,
        historyLoading: () => loading,
        loadMore: loadMoreFn,
        userScrolled: () => true,
        scroller: () => ({ scrollTop: 0 } as HTMLDivElement),
      })

      hook.loadAndReveal()
      dispose()
    })

    expect(loadMoreCalled).toBe(false)
  })
})
