import { describe, expect, test } from "bun:test"
import { attachUrl } from "./attach-url"

describe("attachUrl", () => {
  test("keeps port but replaces non-loopback host with 127.0.0.1", () => {
    expect(attachUrl("http://ellamac:4096")).toBe("http://127.0.0.1:4096")
  })

  test("keeps loopback host untouched", () => {
    expect(attachUrl("http://127.0.0.1:4097")).toBe("http://127.0.0.1:4097")
    expect(attachUrl("http://localhost:4098")).toBe("http://127.0.0.1:4098")
  })

  test("strips trailing slashes", () => {
    expect(attachUrl("http://ellamac:4096/")).toBe("http://127.0.0.1:4096")
    expect(attachUrl("http://ellamac:4096//")).toBe("http://127.0.0.1:4096")
  })

  test("throws on missing input instead of guessing a fallback host", () => {
    expect(() => attachUrl(undefined as unknown as string)).toThrow()
    expect(() => attachUrl("")).toThrow()
  })

  test("throws on malformed url instead of masking the error", () => {
    expect(() => attachUrl("not a url")).toThrow()
  })
})
