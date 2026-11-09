import { NodeHttpServer } from "@effect/platform-node"
import { Layer } from "effect"
import { FetchHttpClient, HttpServer } from "effect/unstable/http"
import { createServer } from "node:http"

// Bind and connect over the same address family. An IPv6 wildcard listener can
// share its port with an unrelated IPv4 service on macOS.
export const loopbackHttpServer = HttpServer.layerTestClient.pipe(
  Layer.provide(
    Layer.fresh(FetchHttpClient.layer).pipe(
      Layer.provide(Layer.succeed(FetchHttpClient.RequestInit)({ keepalive: false })),
    ),
  ),
  Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })),
)
