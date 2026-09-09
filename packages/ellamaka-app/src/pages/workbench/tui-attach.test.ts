import { describe, expect, test } from "bun:test"
import { createTuiAttachRequest, resolveTuiAttachAuth } from "./tui-attach"

describe("createTuiAttachRequest", () => {
  test("keeps Desktop sidecar credentials scoped to the TUI attach PTY", () => {
    const request = createTuiAttachRequest({
      serverUrl: "http://localhost:4096/",
      sessionID: "ses_1",
      directory: "/workspace",
      panelID: "panel_1",
      auth: { username: "ellamaka", password: "secret" },
    })

    expect(request).toEqual({
      command: "ellamaka",
      args: ["attach", "http://127.0.0.1:4096", "-s", "ses_1", "--dir", "/workspace"],
      cwd: "/workspace",
      title: "ellamaka tui (panel_1)",
      env: {
        ELLAMAKA_SERVER_USERNAME: "ellamaka",
        ELLAMAKA_SERVER_PASSWORD: "secret",
      },
    })
  })

  test("does not create credential environment for unauthenticated servers", () => {
    const request = createTuiAttachRequest({
      serverUrl: "http://localhost:4096",
      directory: "/workspace",
      panelID: "panel_1",
    })

    expect(request.env).toBeUndefined()
  })

  test("resolves sidecar credentials only for the desktop sidecar connection", () => {
    const sidecar = { type: "sidecar" as const, variant: "base" as const, http: { url: "http://127.0.0.1:4096", username: "ellamaka", password: "secret" } }
    expect(resolveTuiAttachAuth(sidecar)).toEqual({ username: "ellamaka", password: "secret" })

    const sidecarWithoutPassword = { type: "sidecar" as const, variant: "base" as const, http: { url: "http://127.0.0.1:4096" } }
    expect(resolveTuiAttachAuth(sidecarWithoutPassword)).toBeUndefined()

    const httpWithBasicAuth = { type: "http" as const, http: { url: "http://10.0.0.8:4096", username: "admin", password: "hunter2" } }
    expect(resolveTuiAttachAuth(httpWithBasicAuth)).toBeUndefined()

    expect(resolveTuiAttachAuth(undefined)).toBeUndefined()
  })
})
