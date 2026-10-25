// Diagnostic dump: when the test asks for it, the fixture records that the
// process started and mirrors its own stderr into a file. The engine discards
// the child's stderr, so without this a spawn failure on CI is invisible.
const diagDir = process.env.MCP_FIXTURE_DIAG_DIR
if (diagDir) {
  await Bun.write(diagDir + "/started.txt", String(process.pid)).catch(() => {})
  const stderrChunks: string[] = []
  const originalWrite = process.stderr.write.bind(process.stderr)
  process.stderr.write = (chunk: string | Uint8Array, ...rest: unknown[]) => {
    stderrChunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk))
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- The overload set of stderr.write is wider than the runtime call shape.
    return (originalWrite as (...args: unknown[]) => boolean)(chunk, ...rest)
  }
  const dump = () => {
    Bun.write(diagDir + "/stderr.txt", stderrChunks.join("")).catch(() => {})
    Bun.write(diagDir + "/exited.txt", "exited").catch(() => {})
  }
  process.on("exit", dump)
  process.on("uncaughtException", (error) => {
    stderrChunks.push(String(error?.stack ?? error))
    dump()
    process.exit(1)
  })
}

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
