import { describe, expect, test } from "bun:test"
import { createGitHubForkProvisioner, type GhRunner } from "../../../src/ontology/github"

const upstream = "https://github.com/wopal-cn/wopal-space-ontology"

/** A scripted gh boundary: the adapter must never reach real GitHub in tests. */
function scripted(handlers: {
  login?: () => Promise<string>
  view?: (fullName: string) => Promise<string>
  fork?: (repo: string) => Promise<string>
}) {
  const calls: string[][] = []
  const run: GhRunner = async (args) => {
    calls.push([...args])
    if (args[0] !== "api") throw new Error("unexpected gh call: " + args.join(" "))
    if (args[1] === "user") return (handlers.login ?? (async () => "octocat"))()
    const target = args.find((arg) => arg.startsWith("repos/"))
    if (!target) throw new Error("unexpected gh call: " + args.join(" "))
    if (target.endsWith("/forks")) {
      return (handlers.fork ?? (async () => ""))(target.slice("repos/".length, -"/forks".length))
    }
    return (handlers.view ?? (async () => JSON.stringify({ parent: { full_name: "" } })))(target.slice("repos/".length))
  }
  return { run, calls }
}

function repository(fullName: string, parent: string | null) {
  return JSON.stringify({ full_name: fullName, parent: parent === null ? null : { full_name: parent } })
}

describe("GitHub fork provisioner", () => {
  test("reuses an existing fork whose parent is the requested upstream", async () => {
    const gh = scripted({
      view: async () => repository("octocat/wopal-space-ontology", "wopal-cn/wopal-space-ontology"),
    })
    const provisioner = createGitHubForkProvisioner({ run: gh.run, sleep: async () => undefined })

    await expect(provisioner.ensure(upstream)).resolves.toBe("https://github.com/octocat/wopal-space-ontology.git")
    expect(gh.calls).toEqual([
      ["api", "user", "--jq", ".login"],
      ["api", "repos/octocat/wopal-space-ontology"],
    ])
  })

  test("creates the fork when it is missing, then verifies the created fork", async () => {
    let lookups = 0
    const sleeps: number[] = []
    const gh = scripted({
      view: async () => {
        lookups += 1
        if (lookups === 1) throw new Error("gh: Not Found (HTTP 404)")
        return repository("octocat/wopal-space-ontology", "wopal-cn/wopal-space-ontology")
      },
      fork: async (repo) => {
        expect(repo).toBe("wopal-cn/wopal-space-ontology")
        return ""
      },
    })
    const provisioner = createGitHubForkProvisioner({
      run: gh.run,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds)
      },
    })

    await expect(provisioner.ensure(upstream)).resolves.toBe("https://github.com/octocat/wopal-space-ontology.git")
    expect(gh.calls).toContainEqual(["api", "--method", "POST", "repos/wopal-cn/wopal-space-ontology/forks"])
    expect(lookups).toBe(2)
    expect(sleeps).toEqual([])
  })

  test("refuses a same-named repository that is not a fork of the requested upstream", async () => {
    const gh = scripted({ view: async () => repository("octocat/wopal-space-ontology", "someone/other-ontology") })
    const provisioner = createGitHubForkProvisioner({ run: gh.run, sleep: async () => undefined })

    await expect(provisioner.ensure(upstream)).rejects.toMatchObject({
      code: "ONTOLOGY_FORK_UNAVAILABLE",
      message: expect.stringContaining("is not a fork of wopal-cn/wopal-space-ontology"),
    })
    expect(gh.calls.some((call) => call.includes("--method"))).toBe(false)
  })

  test("reports missing GitHub authentication instead of pretending the fork exists", async () => {
    const gh = scripted({
      login: async () => {
        throw new Error("gh: To get started with GitHub CLI, please run: gh auth login")
      },
    })
    const provisioner = createGitHubForkProvisioner({ run: gh.run, sleep: async () => undefined })

    await expect(provisioner.ensure(upstream)).rejects.toMatchObject({
      code: "ONTOLOGY_FORK_UNAVAILABLE",
      message: "GitHub authentication is unavailable for fork mode",
    })
  })

  test("tries inherited and Home token candidates until one verifies", async () => {
    const gh = scripted({
      login: async () => {
        throw new Error("gh is unavailable")
      },
    })
    const authorizations: string[] = []
    const provisioner = createGitHubForkProvisioner({
      run: gh.run,
      tokens: () => ["stale-shell", "valid-home"],
      sleep: async () => undefined,
      fetcher: async (url, init) => {
        const authorization = new Headers(init?.headers).get("Authorization") ?? ""
        authorizations.push(authorization)
        if (url.endsWith("/user")) {
          return authorization === "Bearer valid-home"
            ? new Response(JSON.stringify({ login: "octocat" }), { status: 200 })
            : new Response("{}", { status: 401 })
        }
        if (url.endsWith("/repos/octocat/wopal-space-ontology")) {
          return new Response(
            JSON.stringify({
              full_name: "octocat/wopal-space-ontology",
              parent: { full_name: "wopal-cn/wopal-space-ontology" },
            }),
            { status: 200 },
          )
        }
        return new Response("{}", { status: 404 })
      },
    })

    await expect(provisioner.ensure(upstream)).resolves.toBe("https://github.com/octocat/wopal-space-ontology.git")
    expect(authorizations).toEqual(["Bearer stale-shell", "Bearer valid-home", "Bearer valid-home"])
  })

  test("uses the verified Home token through GitHub HTTP when gh authentication is unavailable", async () => {
    const gh = scripted({
      login: async () => {
        throw new Error("gh is unavailable")
      },
    })
    let forkVisible = false
    const calls: Array<{ url: string; method: string; authorization: string | null }> = []
    const provisioner = createGitHubForkProvisioner({
      run: gh.run,
      token: () => "placeholder",
      sleep: async () => undefined,
      fetcher: async (url, init) => {
        const method = init?.method ?? "GET"
        calls.push({
          url,
          method,
          authorization: new Headers(init?.headers).get("Authorization"),
        })
        if (url.endsWith("/user")) {
          return new Response(JSON.stringify({ login: "octocat" }), { status: 200 })
        }
        if (url.endsWith("/repos/octocat/wopal-space-ontology")) {
          return forkVisible
            ? new Response(
                JSON.stringify({
                  full_name: "octocat/wopal-space-ontology",
                  parent: { full_name: "wopal-cn/wopal-space-ontology" },
                }),
                { status: 200 },
              )
            : new Response("{}", { status: 404 })
        }
        if (url.endsWith("/repos/wopal-cn/wopal-space-ontology/forks") && method === "POST") {
          forkVisible = true
          return new Response("{}", { status: 202 })
        }
        return new Response("{}", { status: 404 })
      },
    })

    await expect(provisioner.ensure(upstream)).resolves.toBe("https://github.com/octocat/wopal-space-ontology.git")
    expect(calls.map((call) => [call.method, call.url])).toEqual([
      ["GET", "https://api.github.com/user"],
      ["GET", "https://api.github.com/repos/octocat/wopal-space-ontology"],
      ["POST", "https://api.github.com/repos/wopal-cn/wopal-space-ontology/forks"],
      ["GET", "https://api.github.com/repos/octocat/wopal-space-ontology"],
    ])
    expect(calls.every((call) => call.authorization === "Bearer placeholder")).toBe(true)
  })

  test("fails when GitHub never reports the fork it was asked to create", async () => {
    const sleeps: number[] = []
    const gh = scripted({
      view: async () => {
        throw new Error("gh: Not Found (HTTP 404)")
      },
    })
    const provisioner = createGitHubForkProvisioner({
      run: gh.run,
      attempts: 3,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds)
      },
    })

    await expect(provisioner.ensure(upstream)).rejects.toMatchObject({
      code: "ONTOLOGY_FORK_UNAVAILABLE",
      message: expect.stringContaining("did not report the fork"),
    })
    expect(sleeps).toHaveLength(2)
  })

  test("rejects a non-GitHub source before invoking gh", async () => {
    const gh = scripted({})
    const provisioner = createGitHubForkProvisioner({ run: gh.run, sleep: async () => undefined })

    await expect(provisioner.ensure("file:///tmp/ontology")).rejects.toMatchObject({
      code: "ONTOLOGY_FORK_UNAVAILABLE",
      message: "Fork mode requires a GitHub repository source",
    })
    expect(gh.calls).toEqual([])
  })
})
