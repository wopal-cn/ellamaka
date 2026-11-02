import { describe, expect, test } from "bun:test"
import { fetchSpaces, type WopalSpace } from "./space-store"
import { isSpaceNotFound } from "./space-store"

type SpaceListData = {
  data?: { items?: Array<{ name: string; displayName: string; path: string; type?: string }> } | null
}

/** Registered Spaces now come from the Public Platform WopalSpace contract. */
function mockSdk(spaces: WopalSpace[] | Error): {
  client: { wopalSpace: { space: { list: () => Promise<SpaceListData> } } }
} {
  return {
    client: {
      wopalSpace: {
        space: {
          list: async () => {
            if (spaces instanceof Error) throw spaces
            return {
              data: {
                items: spaces.map((space) => ({
                  name: space.id,
                  displayName: space.name,
                  path: space.path,
                  ...(space.type === undefined ? {} : { type: space.type }),
                })),
              },
            }
          },
        },
      },
    },
  }
}

describe("fetchSpaces", () => {
  test("resolves alias path through the app BFF without changing space.list", async () => {
    const sdk = {
      ...mockSdk([{ id: "a", name: "A", path: "/alias/a" }]),
      bff: { workbench: { locations: async () => ({ data: { scopePath: "/real/a" } }) } },
    }
    expect((await fetchSpaces(sdk))[0]?.path).toBe("/real/a")
  })
  test("distinguishes authoritative missing Space from transport failure", () => {
    expect(isSpaceNotFound({ _tag: "WorkbenchSpaceNotFound" })).toBe(true)
    expect(isSpaceNotFound({ status: 404 })).toBe(true)
    expect(isSpaceNotFound(new TypeError("Failed to fetch"))).toBe(false)
  })
  test("returns the registered Space list using the stable registry key as id", async () => {
    const spaces: WopalSpace[] = [
      { id: "space-a", name: "Space A", path: "/fixtures/space-a", type: "space" },
      { id: "space-b", name: "Space B", path: "/fixtures/space-b", type: "space" },
    ]
    const sdk = mockSdk(spaces)

    const result = await fetchSpaces(sdk)

    expect(result).toEqual(spaces)
    expect(result).toHaveLength(2)
    expect(result[0].id).toBe("space-a")
  })

  test("uses displayName for presentation and the registry key for identity", async () => {
    const sdk = mockSdk([{ id: "my-space", name: "我的空间", path: "/fixtures/my-space" }])

    const result = await fetchSpaces(sdk)

    expect(result).toEqual([{ id: "my-space", name: "我的空间", path: "/fixtures/my-space" }])
  })

  test("propagates a query failure so the store can preserve the last successful list", async () => {
    const sdk = mockSdk(new Error("Network failure"))
    await expect(fetchSpaces(sdk)).rejects.toThrow("Network failure")
  })

  test("returns empty array when the response has no body", async () => {
    const sdk = { client: { wopalSpace: { space: { list: async (): Promise<SpaceListData> => ({ data: null }) } } } }

    const result = await fetchSpaces(sdk)

    expect(result).toEqual([])
  })

  test("returns empty array when the response omits data", async () => {
    const sdk = { client: { wopalSpace: { space: { list: async (): Promise<SpaceListData> => ({}) } } } }

    const result = await fetchSpaces(sdk)

    expect(result).toEqual([])
  })

  test("normalizes Windows backslash paths returned by the server", async () => {
    const rawSpaces: WopalSpace[] = [
      { id: "win-space", name: "Win Space", path: "C:\\Users\\Sam\\Project", type: "space" },
    ]
    const sdk = mockSdk(rawSpaces)

    const result = await fetchSpaces(sdk)

    expect(result[0].path).toBe("C:/Users/Sam/Project")
    expect(result[0].id).toBe("win-space")
  })
})
