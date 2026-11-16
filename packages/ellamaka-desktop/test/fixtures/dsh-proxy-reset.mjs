import { createServer, request } from "node:http"
import { pathToFileURL } from "node:url"

const { createDshHttpProxy } = await import(pathToFileURL(process.argv[2]).href)
const mode = process.argv[3]
const uncaught = []
let sawResponse = false
process.on("uncaughtException", (error) => {
  uncaught.push(error.code ?? error.message)
})

const upstream = createServer((_req, res) => {
  if (mode !== "http") return
  res.writeHead(200, { "content-type": "text/plain" })
  res.write("partial")
  setTimeout(() => res.socket?.resetAndDestroy(), 30)
})
upstream.on("upgrade", (_req, socket) => {
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      "Sec-WebSocket-Accept: synthetic\r\n\r\n",
  )
  setTimeout(() => socket.resetAndDestroy(), 30)
})

await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve))
const address = upstream.address()
const proxy = createDshHttpProxy()
proxy.setTarget(`http://127.0.0.1:${address.port}`)
const port = await proxy.listen(0)
const client = request({
  hostname: "127.0.0.1",
  port,
  path: "/dsh/realtime",
  headers: mode === "ws" ? { connection: "Upgrade", upgrade: "websocket" } : {},
})
client.on("response", (response) => {
  sawResponse = true
  response.on("error", () => {})
  response.resume()
})
client.on("upgrade", (_response, socket) => {
  sawResponse = true
  socket.on("error", () => {})
  socket.resume()
})
client.on("error", () => {})
client.end()

await new Promise((resolve) => setTimeout(resolve, 250))
proxy.server.closeAllConnections()
proxy.server.close()
upstream.closeAllConnections()
upstream.close()
console.log(JSON.stringify({ mode, sawResponse, uncaught }))
process.exit(uncaught.length > 0 ? 75 : sawResponse ? 0 : 77)
