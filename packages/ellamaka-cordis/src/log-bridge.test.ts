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

    expect(
      classifyCordisPluginLog({
        name: "dsh-adapter",
        level: "ERROR",
        body: 'tool execution failed {"tool":"edit","code":"FS_NOT_OBSERVED","error":"cannot modify \\"/private/project/secret.ts\\": file has not been read — read the file, then retry"}',
      }),
    ).toEqual({
      level: "DEBUG",
      body: "tool outcome rejected tool=edit reason=read-required",
    })
  })

  test("demotes expected built-in dsh-adapter read, edit, sandbox, and cancellation outcomes to debug", () => {
    expect(
      classifyCordisPluginLog({
        name: "dsh-adapter",
        level: "ERROR",
        body: 'tool execution failed {"tool":"read","code":"FS_NOT_FOUND","error":"cannot read \\"/private/project/missing.ts\\": not found"}',
      }),
    ).toEqual({
      level: "DEBUG",
      body: "tool outcome rejected tool=read reason=target-missing",
    })

    expect(
      classifyCordisPluginLog({
        name: "dsh-adapter",
        level: "ERROR",
        body: 'tool execution failed {"tool":"edit","code":"FS_EDIT_NOT_FOUND","error":"old_string was not found in \\"/private/project/a.ts\\""}',
      }),
    ).toEqual({
      level: "DEBUG",
      body: "tool outcome rejected tool=edit reason=edit-mismatch",
    })

    expect(
      classifyCordisPluginLog({
        name: "dsh-adapter",
        level: "ERROR",
        body: 'tool execution failed {"tool":"write","code":"FS_SANDBOX_DENIED","error":"[sandbox: file access denied under read-only mode]"}',
      }),
    ).toEqual({
      level: "DEBUG",
      body: "tool outcome rejected tool=write reason=permission-denied",
    })

    expect(
      classifyCordisPluginLog({
        name: "dsh-adapter",
        level: "ERROR",
        body: 'tool execution failed {"tool":"bash","code":"TOOL_TIMEOUT","error":"tool call timed out after 5000ms"}',
      }),
    ).toEqual({
      level: "DEBUG",
      body: "tool outcome rejected tool=bash reason=cancelled",
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
