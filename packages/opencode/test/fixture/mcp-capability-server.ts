// Standalone MCP server used as a real stdio fixture by capability discovery
// tests. It exposes:
// - one tool whose name needs sanitizing on the engine side
//   (`fixture.tool/one` → `fixture_tool_one`), with a small input schema so the
//   endpoint's parameter summary can be asserted;
// - a collision pair (`fixture.collide.one` and `fixture.collide/one`) that
//   sanitize to the same runtime composite key (`fixture_collide_one`), which
//   pins the discovery surface to the runtime-effective set (last writer wins).
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"

const server = new Server({ name: "capability-fixture", version: "1.0.0" }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "fixture.tool/one",
      description: "Fixture tool one",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          count: { type: "number" },
        },
      },
    },
    {
      name: "fixture.collide.one",
      description: "Fixture collision loser",
      inputSchema: {
        type: "object",
        properties: {
          loser: { type: "string" },
        },
      },
    },
    {
      name: "fixture.collide/one",
      description: "Fixture collision winner",
      inputSchema: {
        type: "object",
        properties: {
          winner: { type: "string" },
        },
      },
    },
  ],
}))

await server.connect(new StdioServerTransport())
