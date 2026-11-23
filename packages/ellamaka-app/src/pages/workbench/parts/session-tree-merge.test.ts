import { describe, expect, test } from "bun:test"
import { getServerTitlePatches, mergeSessionTreeSessions } from "./session-tree-merge"

describe("mergeSessionTreeSessions", () => {
  test("uses the server title without consulting a local session projection", () => {
    expect(
      mergeSessionTreeSessions([{ id: "ses-1", title: "New session - 2026-07-09T04:04:53.724Z" }], () => false),
    ).toEqual([
      {
        id: "ses-1",
        title: "New session - 2026-07-09T04:04:53.724Z",
        status: "idle",
      },
    ])
  })

  test("marks sessions as bound from live panel bindings instead of local cached status", () => {
    expect(
      mergeSessionTreeSessions([{ id: "ses-1", title: "New session - 2026-07-09T04:04:53.724Z" }], () => true),
    ).toEqual([
      {
        id: "ses-1",
        title: "New session - 2026-07-09T04:04:53.724Z",
        status: "bound",
      },
    ])
  })

  test("never substitutes a locally translated title while the server title is empty", () => {
    expect(mergeSessionTreeSessions([{ id: "ses-1", title: "" }], () => false)).toEqual([
      {
        id: "ses-1",
        title: "ses-1",
        status: "idle",
      },
    ])
  })

  test("deduplicates duplicate server rows by session id only", () => {
    expect(
      mergeSessionTreeSessions(
        [
          { id: "ses-1", title: "New session - 2026-07-09T04:04:53.724Z" },
          { id: "ses-1", title: "新会话 - 2026-07-09T04:04:53.724Z" },
        ],
        () => false,
      ),
    ).toEqual([
      {
        id: "ses-1",
        title: "New session - 2026-07-09T04:04:53.724Z",
        status: "idle",
      },
    ])
  })
})

describe("getServerTitlePatches", () => {
  test("returns server-title corrections for stale local projections", () => {
    expect(
      getServerTitlePatches(
        [{ id: "ses-1", title: "New session - 2026-07-09T04:04:53.724Z" }],
        [
          {
            id: "ses-1",
            spaceName: "main",
            projectPath: "/repo",
            type: "chat",
            title: "新会话 - 2026-07-09T04:04:53.724Z",
            directoryHealth: "healthy",
            createdAt: 1,
            lastActiveAt: 1,
          },
        ],
      ),
    ).toEqual([{ id: "ses-1", title: "New session - 2026-07-09T04:04:53.724Z" }])
  })
})
