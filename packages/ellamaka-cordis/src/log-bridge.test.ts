import { describe, expect, test } from "bun:test"
import { classifyCordisPluginLog } from "./log-bridge"

describe("classifyCordisPluginLog", () => {
  test("demotes a read-before-edit guard to a redacted debug outcome", () => {
    expect(
      classifyCordisPluginLog({
        name: "dsh-adapter",
        level: "ERROR",
        body: 'tool call failed {"tool":"edit","sessionID":"ses_sensitive","callID":"call_sensitive","error":"Error: edit requires reading \\"/private/project/secret.ts\\" first — read the file, then retry"}',
      }),
    ).toEqual({
      level: "DEBUG",
      body: "tool outcome rejected tool=edit reason=read-required",
    })
  })

  test("demotes other expected policy outcomes without persisting their raw error", () => {
    expect(
      classifyCordisPluginLog({
        name: "dsh-sandbox-policy",
        level: "WARN",
        body: "sandbox permission denied for /private/project/.env",
      }),
    ).toEqual({
      level: "DEBUG",
      body: "policy outcome rejected reason=permission-denied",
    })
  })

  test("keeps an unexpected tool execution failure visible but redacted", () => {
    expect(
      classifyCordisPluginLog({
        name: "dsh-adapter",
        level: "ERROR",
        body: 'tool call failed {"tool":"bash","sessionID":"ses_sensitive","error":"Error: spawn failed: ENOENT"}',
      }),
    ).toEqual({
      level: "WARN",
      body: "tool execution failed tool=bash reason=unexpected",
    })
  })

  test("demotes a recoverable plugin retry to debug", () => {
    expect(
      classifyCordisPluginLog({
        name: "dsh-mcp-client",
        level: "WARN",
        body: "mcp-client(local): connection attempt failed: ECONNREFUSED; reconnecting in 1000ms",
      }),
    ).toEqual({
      level: "DEBUG",
      body: "plugin recovery in progress",
    })
  })

  test("keeps a persistent capability loss at error severity", () => {
    expect(
      classifyCordisPluginLog({
        name: "dsh-mcp-client",
        level: "ERROR",
        body: "mcp-client(local): giving up after 3 consecutive failed reconnect attempts — tools unregistered",
      }),
    ).toEqual({
      level: "ERROR",
      body: "plugin capability unavailable reason=tools-unregistered",
    })
  })
})
