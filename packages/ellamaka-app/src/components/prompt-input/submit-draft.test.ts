import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import type { Prompt } from "@/context/prompt"
import * as realRouter from "@solidjs/router"
import * as realClient from "@wopal/ellamaka-sdk/v2/client"
import * as realToast from "@wopal/ui/toast"
import * as realEncode from "@wopal/ellamaka-core/util/encode"
import * as realLocal from "@/context/local"
import * as realPermission from "@/context/permission"
import * as realPrompt from "@/context/prompt"
import * as realLayout from "@/context/layout"
import * as realSdk from "@/context/sdk"
import * as realSync from "@/context/sync"
import * as realServerSync from "@/context/server-sync"
import * as realPlatform from "@/context/platform"
import * as realLanguage from "@/context/language"

const realRouterExports = { ...realRouter }
const realClientExports = { ...realClient }
const realToastExports = { ...realToast }
const realEncodeExports = { ...realEncode }
const realLocalExports = { ...realLocal }
const realPermissionExports = { ...realPermission }
const realPromptExports = { ...realPrompt }
const realLayoutExports = { ...realLayout }
const realSdkExports = { ...realSdk }
const realSyncExports = { ...realSync }
const realServerSyncExports = { ...realServerSync }
const realPlatformExports = { ...realPlatform }
const realLanguageExports = { ...realLanguage }

let createPromptSubmit: typeof import("./submit").createPromptSubmit

const createdSessions: string[] = []
const promoted: Array<{ directory: string; sessionID: string }> = []
const adopted: Array<{ directory: string; sessionID: string }> = []
const sentPrompts: Array<{ sessionID: string }> = []
const storedSessions: Record<string, Array<{ id: string; title?: string }>> = {}
const syncedDirectories: string[] = []
const navigated: string[] = []

let params: { id?: string } = {}

const promptValue: Prompt = [{ type: "text", content: "hello", start: 0, end: 5 }]

const clientFor = (directory: string) => ({
  session: {
    create: async () => {
      createdSessions.push(directory)
      return {
        data: {
          id: `session-${createdSessions.length}`,
          title: `New session ${createdSessions.length}`,
        },
      }
    },
    shell: async () => ({ data: undefined }),
    prompt: async () => ({ data: undefined }),
    promptAsync: async (input: { sessionID: string }) => {
      sentPrompts.push(input)
      return { data: undefined }
    },
    command: async () => ({ data: undefined }),
    abort: async () => ({ data: undefined }),
  },
  worktree: {
    create: async () => ({ data: { directory: `${directory}/new` } }),
  },
})

beforeAll(async () => {
  const rootClient = clientFor("/repo/main")

  mock.module("@solidjs/router", () => ({
    useNavigate: () => (href: string) => {
      navigated.push(href)
    },
    useParams: () => params,
  }))

  mock.module("@wopal/ellamaka-sdk/v2/client", () => ({
    createOpencodeClient: (input: { directory: string }) => clientFor(input.directory),
  }))

  mock.module("@wopal/ui/toast", () => ({
    showToast: () => 0,
  }))

  mock.module("@wopal/ellamaka-core/util/encode", () => ({
    base64Encode: (value: string) => value,
    base64Decode: (value: string) => value,
    hash: async (content: string) => content,
    checksum: () => undefined,
    sampledChecksum: () => undefined,
  }))

  mock.module("@/context/local", () => ({
    useLocal: () => ({
      model: {
        current: () => ({ id: "model", provider: { id: "provider" } }),
        variant: { current: () => undefined },
      },
      agent: {
        current: () => ({ name: "agent" }),
      },
      session: {
        promote(directory: string, sessionID: string) {
          promoted.push({ directory, sessionID })
        },
      },
    }),
  }))

  mock.module("@/context/permission", () => ({
    usePermission: () => ({
      enableAutoAccept() {},
    }),
  }))

  mock.module("@/context/prompt", () => ({
    usePrompt: () => ({
      current: () => promptValue,
      reset: () => undefined,
      set: () => undefined,
      context: {
        add: () => undefined,
        remove: () => undefined,
        items: () => [],
      },
    }),
  }))

  mock.module("@/context/layout", () => ({
    useLayout: () => ({
      handoff: {
        setTabs: () => undefined,
      },
    }),
  }))

  mock.module("@/context/sdk", () => ({
    useSDK: () => ({
      directory: "/repo/main",
      client: rootClient,
      url: "http://localhost:4096",
      createClient(opts: { directory: string }) {
        return clientFor(opts.directory)
      },
    }),
  }))

  mock.module("@/context/sync", () => ({
    useSync: () => ({
      data: { command: [] },
      session: {
        optimistic: {
          add: () => undefined,
          remove: () => undefined,
        },
      },
      set: () => undefined,
    }),
  }))

  mock.module("@/context/server-sync", () => ({
    useServerSync: () => ({
      child: (directory: string) => {
        syncedDirectories.push(directory)
        storedSessions[directory] ??= []
        return [{ session: storedSessions[directory] }, () => undefined]
      },
    }),
  }))

  mock.module("@/context/platform", () => ({
    usePlatform: () => ({ fetch }),
  }))

  mock.module("@/context/language", () => ({
    useLanguage: () => ({ t: (key: string) => key }),
  }))

  const mod = await import("./submit")
  createPromptSubmit = mod.createPromptSubmit
})

beforeEach(() => {
  createdSessions.length = 0
  promoted.length = 0
  adopted.length = 0
  sentPrompts.length = 0
  syncedDirectories.length = 0
  navigated.length = 0
  params = {}
  for (const key of Object.keys(storedSessions)) delete storedSessions[key]
})

const baseInput = () => ({
  info: () => undefined,
  imageAttachments: () => [],
  commentCount: () => 0,
  autoAccept: () => false,
  mode: () => "normal" as const,
  working: () => false,
  editor: () => undefined,
  queueScroll: () => undefined,
  promptLength: (value: Prompt) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
  addToHistory: () => undefined,
  resetHistoryNavigation: () => undefined,
  setMode: () => undefined,
  setPopover: () => undefined,
  onSubmit: () => undefined,
})

const event = { preventDefault: () => undefined } as unknown as Event

describe("prompt submit draft session adoption", () => {
  test("creates the session and adopts it instead of navigating", async () => {
    params = { id: "draft:panel-1" }

    const submit = createPromptSubmit({
      ...baseInput(),
      adoptSession: async (directory, session) => {
        adopted.push({ directory, sessionID: session.id })
        return true
      },
    })

    await submit.handleSubmit(event)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(createdSessions).toEqual(["/repo/main"])
    expect(adopted).toEqual([{ directory: "/repo/main", sessionID: "session-1" }])
    expect(navigated).toEqual([])
    expect(promoted).toEqual([])
    expect(sentPrompts).toEqual([expect.objectContaining({ sessionID: "session-1" })])
  })

  test("aborts the send when adoption is rejected", async () => {
    params = { id: "draft:panel-1" }

    const submit = createPromptSubmit({
      ...baseInput(),
      adoptSession: async () => false,
    })

    await submit.handleSubmit(event)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(createdSessions).toEqual(["/repo/main"])
    expect(adopted).toEqual([])
    expect(sentPrompts).toEqual([])
  })

  test("regular sessions still navigate the legacy way", async () => {
    params = {}

    const submit = createPromptSubmit({ ...baseInput() })

    await submit.handleSubmit(event)

    expect(createdSessions).toEqual(["/repo/main"])
    expect(adopted).toEqual([])
    expect(navigated).toEqual(["//repo/main/session/session-1"])
    expect(promoted).toEqual([{ directory: "/repo/main", sessionID: "session-1" }])
  })
})

afterAll(() => {
  mock.module("@solidjs/router", () => realRouterExports)
  mock.module("@wopal/ellamaka-sdk/v2/client", () => realClientExports)
  mock.module("@wopal/ui/toast", () => realToastExports)
  mock.module("@wopal/ellamaka-core/util/encode", () => realEncodeExports)
  mock.module("@/context/local", () => realLocalExports)
  mock.module("@/context/permission", () => realPermissionExports)
  mock.module("@/context/prompt", () => realPromptExports)
  mock.module("@/context/layout", () => realLayoutExports)
  mock.module("@/context/sdk", () => realSdkExports)
  mock.module("@/context/sync", () => realSyncExports)
  mock.module("@/context/server-sync", () => realServerSyncExports)
  mock.module("@/context/platform", () => realPlatformExports)
  mock.module("@/context/language", () => realLanguageExports)
})
