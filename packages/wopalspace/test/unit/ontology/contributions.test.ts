import { describe, expect, test } from "bun:test"
import { matchingPullRequests } from "../../../src/ontology/contributions"
import { createGitHubPullRequestQuery, parsePullRequest } from "../../../src/ontology/github"
import { OntologyServiceError, type PullRequestSnapshot } from "../../../src/ontology/types"

const identity = { headFork: "fork-owner/wopal-space-ontology", headBranch: "contribute/topic", baseBranch: "main" }

function snapshot(overrides: Partial<PullRequestSnapshot> = {}): PullRequestSnapshot {
  return {
    number: 1,
    url: "https://github.com/wopal-cn/wopal-space-ontology/pull/1",
    state: "open",
    baseBranch: "main",
    headBranch: "contribute/topic",
    headFork: "fork-owner/wopal-space-ontology",
    ...overrides,
  }
}

describe("contribution PR identity matching", () => {
  test("keeps only the exact upstream fork, branch and base identity", () => {
    const matches = matchingPullRequests(
      [
        snapshot(),
        snapshot({ number: 2, headFork: "another-owner/wopal-space-ontology" }),
        snapshot({ number: 3, headBranch: "contribute/other" }),
        snapshot({ number: 4, baseBranch: "release" }),
        snapshot({ number: 1 }),
      ],
      identity,
    )
    expect(matches.map((entry) => entry.number)).toEqual([1])
  })

  test("returns no match for an unrelated fork", () => {
    expect(matchingPullRequests([snapshot({ headFork: "stranger/wopal-space-ontology" })], identity)).toEqual([])
  })
})

describe("GitHub pull request adapter", () => {
  test("scopes the request to the upstream repository, fork owner and branch, then filters pages exactly", async () => {
    const calls: string[][] = []
    const query = createGitHubPullRequestQuery(async (args) => {
      calls.push([...args])
      return JSON.stringify([
        [
          {
            number: 7,
            html_url: "https://github.com/wopal-cn/wopal-space-ontology/pull/7",
            state: "closed",
            merged_at: "2026-10-01T00:00:00Z",
            base: { ref: "main" },
            head: { ref: "contribute/topic", sha: "abc", repo: { full_name: "fork-owner/wopal-space-ontology" } },
          },
          {
            number: 8,
            html_url: "https://github.com/wopal-cn/wopal-space-ontology/pull/8",
            state: "open",
            base: { ref: "main" },
            head: { ref: "contribute/topic", repo: { full_name: "other/wopal-space-ontology" } },
          },
        ],
      ])
    })
    const result = await query.query({
      repo: "/repo",
      upstreamRepo: "wopal-cn/wopal-space-ontology",
      headFork: "fork-owner/wopal-space-ontology",
      headBranch: "contribute/topic",
      baseBranch: "main",
    })
    expect(calls[0]?.[0]).toBe("api")
    expect(calls[0]?.[1]).toBe(
      "repos/wopal-cn/wopal-space-ontology/pulls?state=all&head=fork-owner%3Acontribute%2Ftopic&base=main&per_page=100",
    )
    expect(calls[0]).toEqual(["api", calls[0]?.[1], "--paginate", "--slurp"])
    expect(result).toEqual([
      {
        number: 7,
        url: "https://github.com/wopal-cn/wopal-space-ontology/pull/7",
        state: "merged",
        baseBranch: "main",
        headBranch: "contribute/topic",
        headFork: "fork-owner/wopal-space-ontology",
        headSha: "abc",
      },
    ])
  })

  test("an unavailable GitHub CLI is an explicit error, never an empty success", async () => {
    const query = createGitHubPullRequestQuery(async () => {
      throw new Error("gh: not authenticated")
    })
    await expect(
      query.query({
        repo: "/repo",
        upstreamRepo: "wopal-cn/wopal-space-ontology",
        headFork: "fork-owner/wopal-space-ontology",
        headBranch: "contribute/topic",
        baseBranch: "main",
      }),
    ).rejects.toMatchObject({ code: "ONTOLOGY_PR_UNAVAILABLE" })
  })

  test("parses open, merged and closed states and drops malformed entries", () => {
    const base = { number: 1, html_url: "url", base: { ref: "main" }, head: { ref: "b", repo: { full_name: "o/r" } } }
    expect(parsePullRequest({ ...base, state: "open" })?.state).toBe("open")
    expect(parsePullRequest({ ...base, state: "closed", merged: true })?.state).toBe("merged")
    expect(parsePullRequest({ ...base, state: "closed" })?.state).toBe("closed")
    expect(parsePullRequest({ number: 1 })).toBeUndefined()
  })
})

describe("ontology error surface", () => {
  test("the adapter error carries a stable code", () => {
    expect(new OntologyServiceError({ code: "X", message: "m" }).code).toBe("X")
  })
})
