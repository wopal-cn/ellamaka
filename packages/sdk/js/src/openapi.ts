import document from "./openapi.json" with { type: "json" }

export type OpenApiDocument = {
  openapi: string
  info: { title: string; version: string; [key: string]: unknown }
  paths: Record<string, unknown>
  [key: string]: unknown
}

export const openapi: OpenApiDocument = document
export default openapi
