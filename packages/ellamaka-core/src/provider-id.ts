import { Schema } from "effect"

export const ID = Schema.String.pipe(Schema.brand("ProviderV2.ID"))
export type ID = typeof ID.Type

export * as ProviderV2 from "./provider-id"
