import type { FileContent, FileNode } from "@wopal/ellamaka-sdk/v2/client"

/** Minimal public WopalSpace surface the Workbench needs for Space browsing. */
type SpaceQueryClient = {
  wopalSpace: {
    space: {
      resolve: (input: { directory?: string; name?: string }) => Promise<{ data?: { name?: string } }>
      files: {
        list: (input: { name: string; path?: string }) => Promise<{ data?: { items?: FileNode[] } }>
        read: (input: { name: string; path: string }) => Promise<{ data?: FileContent }>
      }
    }
  }
}

/**
 * Space browsing goes through the Public Platform WopalSpace contract.
 *
 * The registry key (`name`) is the stable identity; a Workbench panel holds an
 * absolute Space path, so resolve it once and cache the mapping for the session.
 */
export function createSpaceQuery(client: SpaceQueryClient) {
  const names = new Map<string, string>()

  const nameFor = async (spacePath: string) => {
    const cached = names.get(spacePath)
    if (cached) return cached
    const resolved = await client.wopalSpace.space.resolve({ directory: spacePath })
    const name = resolved.data?.name
    if (!name) throw new Error(`Registered Space not found: ${spacePath}`)
    names.set(spacePath, name)
    return name
  }

  return {
    nameFor,
    async list(spacePath: string, path: string): Promise<FileNode[]> {
      const name = await nameFor(spacePath)
      const response = await client.wopalSpace.space.files.list({ name, path })
      return response.data?.items ?? []
    },
    async read(spacePath: string, path: string): Promise<FileContent | undefined> {
      const name = await nameFor(spacePath)
      const response = await client.wopalSpace.space.files.read({ name, path })
      return response.data
    },
  }
}
