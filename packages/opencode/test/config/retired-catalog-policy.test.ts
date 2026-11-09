import { expect, test } from "bun:test"
import { Schema } from "effect"
import { Config } from "../../src/config/config"

test("retired catalog policy does not enter the runtime configuration", () => {
  const config = Schema.decodeUnknownSync(Config.Info)({
    experimental: {
      policies: [{ action: "provider.use", effect: "deny", resource: "example" }],
      batch_tool: true,
    },
  })
  expect(config.experimental).toEqual({ batch_tool: true })
})
