import { createServer } from "node:http"
import WebSocket, { WebSocketServer } from "ws"
import { pathToFileURL } from "node:url"

const { createDshHttpProxy } = await import(pathToFileURL(process.argv[2]).href)
const backend = createServer()
const upstream = new WebSocketServer({ noServer: true, perMessageDeflate: true })
let upstreamExtensions = ""
backend.on("upgrade", (request, socket, head) => {
  upstream.handleUpgrade(request, socket, head, (ws) => {
    upstreamExtensions = ws.extensions
    ws.send("dsh-ready:" + "x".repeat(4096), { compress: true })
  })
})

await new Promise((resolve) => backend.listen(0, "127.0.0.1", resolve))
const proxy = createDshHttpProxy()
proxy.setTarget(`http://127.0.0.1:${backend.address().port}`)
const port = await proxy.listen(0)

let received = false
let forwardedExtensions = ""
let errorMessage = ""
const socket = new WebSocket(`ws://127.0.0.1:${port}/dsh/api/remote.mux`, { perMessageDeflate: true })
socket.on("upgrade", (response) => {
  forwardedExtensions = response.headers["sec-websocket-extensions"] ?? ""
})
const result = await Promise.race([
  new Promise((resolve) => {
    socket.on("message", (data) => {
      received = Buffer.isBuffer(data) && data.toString("utf8") === "dsh-ready:" + "x".repeat(4096)
      resolve()
    })
    socket.on("error", (error) => {
      errorMessage = error.message
      resolve()
    })
    socket.on("close", () => resolve())
  }),
  new Promise((resolve) => setTimeout(resolve, 3000)),
])
void result
socket.terminate()
for (const client of upstream.clients) client.terminate()
upstream.close()
proxy.server.closeAllConnections()
proxy.server.close()
backend.closeAllConnections()
backend.close()

const negotiated = upstreamExtensions.includes("permessage-deflate")
const forwarded = forwardedExtensions.includes("permessage-deflate")
console.log(JSON.stringify({ negotiated, forwarded, received, errorMessage }))
process.exit(negotiated && forwarded && received ? 0 : 75)
