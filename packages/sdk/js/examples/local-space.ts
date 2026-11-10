/**
 * Read Ontology and Space facts in-process, with no HTTP Server running.
 *
 * Run:  node examples/local-space.ts
 * Reads $WOPAL_HOME (defaults to ~/.wopal) and the Space containing the current directory.
 * Only `wopal-space.ontology` and `wopal-space.space` exist on this transport.
 */
import { createEllamakaLocalClient } from "@wopal/ellamaka-sdk/local"

const local = await createEllamakaLocalClient({ directory: process.cwd() })
try {
  const ontologies = await local.client.wopalSpace.ontology.list()
  if (ontologies.error) throw new Error(`ontology.list failed: ${JSON.stringify(ontologies.error)}`)
  for (const ontology of ontologies.data?.items ?? []) console.log("ontology:", ontology.name)

  const spaces = await local.client.wopalSpace.space.list()
  if (spaces.error) throw new Error(`space.list failed: ${JSON.stringify(spaces.error)}`)
  for (const space of spaces.data?.items ?? []) {
    const status = await local.client.wopalSpace.space.status({ name: space.name })
    console.log("space:", space.name, "branch:", status.data?.space.branch ?? "-")
  }
} finally {
  // Waits for accepted writes to finish, then shuts the Worker down.
  await local.dispose()
}
