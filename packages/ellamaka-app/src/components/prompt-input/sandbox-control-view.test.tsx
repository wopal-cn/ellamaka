import { describe, expect, test } from "bun:test"
import { createComponent } from "solid-js"
import { render } from "solid-js/web"
import type { useCheckServerHealth } from "@/utils/server-health"
import { PromptInputSandboxControl } from "./sandbox-control-view"

const directory = "/workspaces/zero-inline"
const baseUrl = "http://sandbox-control.test"
const requests: string[] = []

const fetchSandboxSurface = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const request = input instanceof Request ? input : new Request(input, init)
  const url = new URL(request.url)
  requests.push(url.pathname + url.search)

  if (url.pathname === "/global/health") {
    return Response.json({
      healthy: true,
      version: "test",
      cli: { state: "ok", requiredVersion: "test" },
      dsh: "ready",
    })
  }
  if (url.pathname === "/config-v2") {
    return Response.json({
      effective: {
        ellamaka: { plugin: ["file:///spaces/zero-inline/plugins/dsh-adapter/index.ts"] },
        wopal: { pluginConfig: { "dsh-adapter": { sandbox: { enabled: true, mode: "read-only" } } } },
      },
    })
  }
  return Response.json({ message: `Unexpected request: ${url.pathname}` }, { status: 404 })
}

const sdk = {
  directory,
  createClient: ({ directory: target }: { directory: string }) => {
    if (target !== directory) throw new Error(`Unexpected directory client: ${target}`)
    return {
      config: {
        configGet: async () => {
          const response = await fetchSandboxSurface(`${baseUrl}/config-v2?directory=${encodeURIComponent(target)}`)
          return { data: await response.json() }
        },
      },
    }
  },
}
const checkHealth: ReturnType<typeof useCheckServerHealth> = async () => {
  await fetchSandboxSurface(`${baseUrl}/global/health`)
  return {
    healthy: true,
    version: "test",
    cli: { state: "ok", requiredVersion: "test" },
    dsh: "ready",
  }
}

describe("PromptInput sandbox control config-v2 integration", () => {
  test("uses the directory SDK and global health for a zero-inline plugin, defaulting from pluginConfig", async () => {
    const host = document.createElement("div")
    document.body.append(host)
    requests.length = 0
    const dispose = render(
      () =>
        createComponent(PromptInputSandboxControl, {
          variant: "dock",
          sdk,
          serverHttp: () => ({ url: baseUrl }),
          checkServerHealth: checkHealth,
          onSelect: () => {},
          t: (key) => key,
        }),
      host,
    )

    try {
      await waitFor(() => requests.includes("/global/health") && host.querySelector("[data-sandbox-preset]"))
      expect(requests).toContain("/global/health")
      expect(
        requests.some(
          (request) => request.startsWith("/config-v2?") && request.includes(encodeURIComponent(directory)),
        ),
      ).toBe(true)
      expect(requests).not.toContain("/config")
      expect(host.querySelector("[data-sandbox-preset]")?.getAttribute("data-sandbox-preset")).toBe("read-only")
    } finally {
      dispose()
      host.remove()
    }
  })
})

async function waitFor(predicate: () => unknown, timeout = 1000) {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for sandbox control to render")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
