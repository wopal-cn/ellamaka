import { createOpencodeClient, createOpencodeServer } from "@wopal/ellamaka-sdk"
import { pathToFileURL } from "bun"

const server = await createOpencodeServer()
const client = createOpencodeClient({ baseUrl: server.url })

const input = await Array.fromAsync(new Bun.Glob("packages/ellamaka-core/src/*.ts").scan())

const tasks: Promise<void>[] = []
for (const file of input) {
  console.log("processing", file)
  const session = await client.session.create()
  if (!session.data) throw new Error("Session creation failed")
  tasks.push(
    client.session.prompt({
      sessionID: session.data.id,
      parts: [
        {
          type: "file",
          mime: "text/plain",
          url: pathToFileURL(file).href,
        },
        {
          type: "text",
          text: `Write tests for every public function in this file.`,
        },
      ],
    }),
  )
  console.log("done", file)
}

await Promise.all(
  input.map(async (file) => {
    const session = await client.session.create()
    console.log("processing", file)
    if (!session.data) throw new Error("Session creation failed")
    await client.session.prompt({
      sessionID: session.data.id,
      parts: [
        {
          type: "file",
          mime: "text/plain",
          url: pathToFileURL(file).href,
        },
        {
          type: "text",
          text: `Write tests for every public function in this file.`,
        },
      ],
    })
    console.log("done", file)
  }),
)
