import { OpenApi } from "effect/unstable/httpapi"
import { PublicApi } from "./public"

export type PublicOpenApiDocument = ReturnType<typeof OpenApi.fromApi>

export function publicOpenApi(): PublicOpenApiDocument {
  return OpenApi.fromApi(PublicApi)
}

export function generatedOpenApi(): PublicOpenApiDocument {
  const specs = publicOpenApi()

  for (const item of Object.values(specs.paths)) {
    for (const method of ["get", "post", "put", "delete", "patch"] as const) {
      const operation = item[method]
      if (!operation?.operationId) continue
      Object.assign(operation, {
        "x-codeSamples": [
          {
            lang: "js",
            source: [
              `import { createOpencodeClient } from "@wopal/ellamaka-sdk`,
              ``,
              `const client = createOpencodeClient()`,
              `await client.${operation.operationId}({`,
              `  ...`,
              `})`,
            ].join("\n"),
          },
        ],
      })
    }
  }

  return specs
}
