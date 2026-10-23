import type { CommandModule } from "yargs"
import { generatedOpenApi } from "../../server/routes/instance/httpapi/openapi"

type Args = {}

export async function generateOpenApiJson() {
  const raw = JSON.stringify(generatedOpenApi(), null, 2)

  const prettier = await import("prettier")
  const babel = await import("prettier/plugins/babel")
  const estree = await import("prettier/plugins/estree")
  const format = prettier.format ?? prettier.default?.format
  return format(raw, {
    parser: "json",
    plugins: [babel.default ?? babel, estree.default ?? estree],
    printWidth: 120,
  })
}

export const GenerateCommand = {
  command: "generate",
  builder: (yargs) => yargs,
  handler: async () => {
    const json = await generateOpenApiJson()
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(json, (err) => {
        if (err) reject(err)
        else resolve()
      })
    })
  },
} satisfies CommandModule<object, Args>
