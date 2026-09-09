import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { loadModelCatalog } from "./model-catalog"

const catalog = JSON.stringify({
  acme: {
    id: "acme",
    name: "Acme",
    env: ["ACME_API_KEY"],
    models: {
      "acme-1": { id: "acme-1", name: "Acme One" },
    },
  },
})

const otherCatalog = JSON.stringify({
  beta: {
    id: "beta",
    name: "Beta",
    env: ["BETA_API_KEY"],
    models: {
      "beta-1": { id: "beta-1", name: "Beta One" },
    },
  },
})

const quietWarn = () => {}

async function withTempDir<A>(callback: (dir: string) => Promise<A>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ellamaka-model-catalog-"))
  try {
    return await callback(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function response(body: string, ok = true) {
  return {
    ok,
    text: async () => body,
  }
}

describe("loadModelCatalog", () => {
  test("the generator adapter uses only the Ellamaka catalog environment inputs", async () => {
    const source = await readFile(path.join(import.meta.dir, "generate.ts"), "utf8")
    expect(source).toContain("process.env.ELLAMAKA_MODELS_API_JSON")
    expect(source).toContain("process.env.ELLAMAKA_MODELS_URL")
    expect(source).not.toContain("OPENCODE_MODELS_")
    expect(source).not.toContain("MODELS_DEV_API_JSON")
  })

  test("every build entry defines the Ellamaka inline catalog identifier", async () => {
    const buildEntries = [
      path.join(import.meta.dir, "build.ts"),
      path.join(import.meta.dir, "build-node.ts"),
      path.resolve(import.meta.dir, "../../ellamaka-release/src/cli/build.ts"),
    ]

    for (const entry of buildEntries) {
      const source = await readFile(entry, "utf8")
      expect(source).toContain("ELLAMAKA_MODELS_DEV: generated.modelsData")
      expect(source).not.toContain("OPENCODE_MODELS_DEV: generated.modelsData")
    }
  })

  test("prefers a valid ELLAMAKA_MODELS_API_JSON file over network and snapshot", async () => {
    await withTempDir(async (dir) => {
      const explicitPath = path.join(dir, "explicit.json")
      const snapshotPath = path.join(dir, "models.json")
      await writeFile(explicitPath, catalog)
      await writeFile(snapshotPath, otherCatalog)

      const result = await loadModelCatalog({
        explicitPath,
        snapshotPath,
        sourceUrl: "https://catalog.example.test",
        release: false,
        readFile: (filepath) => readFile(filepath, "utf8"),
        warn: quietWarn,
        fetch: async () => {
          throw new Error("network should not be called when the explicit file is valid")
        },
      })

      expect(result).toEqual({ data: catalog, source: "explicit" })
    })
  })

  test("skips an invalid explicit file and uses a valid network catalog", async () => {
    await withTempDir(async (dir) => {
      const explicitPath = path.join(dir, "explicit.json")
      const snapshotPath = path.join(dir, "models.json")
      await writeFile(explicitPath, "{}")
      await writeFile(snapshotPath, otherCatalog)
      const calls: string[] = []

      const result = await loadModelCatalog({
        explicitPath,
        snapshotPath,
        sourceUrl: "https://catalog.example.test",
        release: false,
        readFile: (filepath) => readFile(filepath, "utf8"),
        warn: quietWarn,
        fetch: async (url) => {
          calls.push(url)
          return response(catalog)
        },
      })

      expect(result).toEqual({ data: catalog, source: "network" })
      expect(calls).toEqual(["https://catalog.example.test/api.json"])
    })
  })

  test("uses the read-only snapshot when network JSON is invalid", async () => {
    await withTempDir(async (dir) => {
      const snapshotPath = path.join(dir, "models.json")
      await writeFile(snapshotPath, catalog)
      const before = await readFile(snapshotPath, "utf8")

      const result = await loadModelCatalog({
        snapshotPath,
        sourceUrl: "https://catalog.example.test",
        release: false,
        readFile: (filepath) => readFile(filepath, "utf8"),
        warn: quietWarn,
        fetch: async () => response("{\"acme\":"),
      })

      expect(result).toEqual({ data: catalog, source: "snapshot" })
      expect(await readFile(snapshotPath, "utf8")).toBe(before)
    })
  })

  test("uses the read-only snapshot when the network catalog has an invalid provider record", async () => {
    await withTempDir(async (dir) => {
      const snapshotPath = path.join(dir, "models.json")
      await writeFile(snapshotPath, catalog)

      const result = await loadModelCatalog({
        snapshotPath,
        sourceUrl: "https://catalog.example.test",
        release: false,
        readFile: (filepath) => readFile(filepath, "utf8"),
        warn: quietWarn,
        fetch: async () => response(JSON.stringify({ acme: {} })),
      })

      expect(result).toEqual({ data: catalog, source: "snapshot" })
    })
  })

  test("uses the read-only snapshot when the network response is not OK", async () => {
    await withTempDir(async (dir) => {
      const snapshotPath = path.join(dir, "models.json")
      await writeFile(snapshotPath, catalog)

      const result = await loadModelCatalog({
        snapshotPath,
        sourceUrl: "https://catalog.example.test",
        release: false,
        readFile: (filepath) => readFile(filepath, "utf8"),
        warn: quietWarn,
        fetch: async () => response("service unavailable", false),
      })

      expect(result).toEqual({ data: catalog, source: "snapshot" })
    })
  })

  test("uses the official catalog URL by default", async () => {
    await withTempDir(async (dir) => {
      const calls: string[] = []
      const result = await loadModelCatalog({
        snapshotPath: path.join(dir, "missing.json"),
        release: false,
        readFile: (filepath) => readFile(filepath, "utf8"),
        warn: quietWarn,
        fetch: async (url) => {
          calls.push(url)
          return response(catalog)
        },
      })

      expect(result).toEqual({ data: catalog, source: "network" })
      expect(calls).toEqual(["https://models.opencode.ai/api.json"])
    })
  })

  test("warns and returns an empty catalog only in development when every source is invalid", async () => {
    await withTempDir(async (dir) => {
      const warnings: string[] = []
      const result = await loadModelCatalog({
        explicitPath: path.join(dir, "missing.json"),
        snapshotPath: path.join(dir, "missing-snapshot.json"),
        release: false,
        readFile: (filepath) => readFile(filepath, "utf8"),
        fetch: async () => response("{}"),
        warn: (message) => warnings.push(message),
      })

      expect(result).toEqual({ data: "{}", source: "empty" })
      expect(warnings.some((message) => message.includes("No valid provider catalog"))).toBe(true)
    })
  })

  test("fails the release build when every source is invalid", async () => {
    await withTempDir(async (dir) => {
      await expect(
        loadModelCatalog({
          snapshotPath: path.join(dir, "missing.json"),
          release: true,
          readFile: (filepath) => readFile(filepath, "utf8"),
          warn: quietWarn,
          fetch: async () => response("{}"),
        }),
      ).rejects.toThrow("No valid provider catalog available for release build")
    })
  })
})
