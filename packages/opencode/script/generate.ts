import path from "path"
import { fileURLToPath } from "url"
import { Script } from "@wopal/ellamaka-release/build-env"
import { loadModelCatalog } from "./model-catalog"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

process.chdir(dir)

const catalog = await loadModelCatalog({
  explicitPath: process.env.ELLAMAKA_MODELS_API_JSON,
  sourceUrl: process.env.ELLAMAKA_MODELS_URL,
  snapshotPath: path.resolve(dir, "../../.ci/models.json"),
  release: Script.release,
  warn: (message) => console.warn(`[generate] Warning: ${message}`),
})

export const modelsData = catalog.data
console.log(`Loaded provider catalog from ${catalog.source}`)
