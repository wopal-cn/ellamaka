export type CompactSessionModel = {
  providerID: string
  modelID: string
}

export type CompactSessionInput = {
  client: {
    session: {
      summarize: (params: { sessionID: string; modelID?: string; providerID?: string }) => Promise<unknown>
    }
  }
  sessionID?: string
  model?: CompactSessionModel | null
}

/**
 * Compacts the current session by summarizing it with the active model.
 * Returns false (and performs no request) when the session or model is missing.
 */
export async function compactSession(input: CompactSessionInput): Promise<boolean> {
  if (!input.sessionID || !input.model) return false
  await input.client.session.summarize({
    sessionID: input.sessionID,
    modelID: input.model.modelID,
    providerID: input.model.providerID,
  })
  return true
}
