import { parseDocument, Schema } from "yaml"

/** Standard DSH YAML rows for the session-free tools container. */
export const TOOLS_PROFILE_ROWS = `# Ellamaka session-free tools composition. Standard DSH profile patch syntax.
- insert:
    - id: timer
      name: '@deepseek-ai/cordis-plugin-timer'
    - id: session-projection
      name: '@deepseek-ai/dsh-session-projection'
    - id: working-directory
      name: '@deepseek-ai/dsh-working-directory'
    - id: storage
      name: '@deepseek-ai/dsh-storage'
    - id: storage-json
      name: '@deepseek-ai/dsh-storage-json'
      config:
        root: !!js dshHomePath('storages')
    - id: storage-domain
      name: '@deepseek-ai/dsh-storage-domain'
      config:
        backend: json
    - id: subprocess
      name: '@deepseek-ai/dsh-subprocess-local'
    - id: sandbox
      name: '@deepseek-ai/dsh-sandbox-local'
    - id: sandbox-policy
      name: '@deepseek-ai/dsh-sandbox-policy'
      config:
        mode: !!js process.env.DSH_PERMISSION_MODE ?? 'workspace-write'
        workspaceRoot: !!js process.cwd()
    - id: bash-sandbox
      name: '@deepseek-ai/dsh-bash-sandbox'
      disabled: !!js process.platform === 'win32'
    - id: pwsh-sandbox
      name: '@deepseek-ai/dsh-pwsh-sandbox'
      disabled: !!js process.platform !== 'win32'
    - id: approval
      name: '@deepseek-ai/dsh-user-approval'
      config:
        policy: !!js >-
          (process.env.DSH_PERMISSION_MODE ?? 'workspace-write') === 'danger-full-access' ? 'never' : 'ask'
    - id: shell-env
      name: '@deepseek-ai/dsh-shell-env'
    - id: tool-bash
      name: '@deepseek-ai/dsh-tool-bash'
      disabled: !!js process.platform === 'win32'
      config:
        enableRunInBackground: false
    - id: tool-pwsh
      name: '@deepseek-ai/dsh-tool-pwsh'
      disabled: !!js process.platform !== 'win32'
      config:
        enableRunInBackground: false
    - id: fs-observation-policy
      name: '@deepseek-ai/dsh-fs-observation-policy'
      disabled: true
    - id: tool-fs
      name: '@deepseek-ai/dsh-tool-fs'
    - id: tool-fs-search
      name: '@deepseek-ai/dsh-tool-fs-search'
      config:
        sampleOverCapGlobResults: false
    - id: timeout-policy
      name: '@deepseek-ai/dsh-tool-call-timeout-policy'
    - id: spill-local
      name: '@deepseek-ai/dsh-spill-local'
    - id: spill-policy
      name: '@deepseek-ai/dsh-spill-policy'
    - id: tools
      name: '@deepseek-ai/dsh-tools'
    - id: tool-executor-native
      name: '@deepseek-ai/dsh-tool-executor-native'
    - id: system-prompt
      name: '@deepseek-ai/dsh-system-prompt'
      config:
        personaPrefix: ''
    - id: fs-sandbox
      name: '@deepseek-ai/dsh-fs-sandbox'
    - id: tool-str-replace-editor
      name: '@deepseek-ai/dsh-tool-str-replace-editor'

`

export const TOOLS_BUILTIN_LAYER_NAME = "ellamaka-tools (built-in)"

/**
 * The entry-list YAML dialect (official `entryListSchema`): default YAML
 * extended with a `!!js` scalar returning `{ __jsExpr: string }`.
 */
export const DSH_PATCH_ENTRY_LIST_SCHEMA = new Schema({
  customTags: [{ tag: "tag:yaml.org,2002:js", resolve: (expression: string) => ({ __jsExpr: expression }) }],
})

export const TOOLS_PROFILE_BLOCK_BEGIN =
  "# >>> ellamaka-tools composition (product-owned; refreshed with the DSH closure)\n"
export const TOOLS_PROFILE_BLOCK_END = "# <<< ellamaka-tools composition\n"

/** Legacy delimited block kept for stripping historical disk copies and test fixtures. */
export const TOOLS_PROFILE_BLOCK = TOOLS_PROFILE_BLOCK_BEGIN + TOOLS_PROFILE_ROWS + TOOLS_PROFILE_BLOCK_END

/** Remove any legacy product-owned block from an existing `cordis.patch.yml` text in memory. */
export function stripLegacyToolsProductBlock(content: string): string {
  const start = content.indexOf(TOOLS_PROFILE_BLOCK_BEGIN)
  const end = content.indexOf(TOOLS_PROFILE_BLOCK_END)
  if (start === -1 || end === -1 || end < start) return content
  return content.slice(0, start) + content.slice(end + TOOLS_PROFILE_BLOCK_END.length)
}

let cachedToolsBasePatches: unknown[] | undefined

/** Parsed built-in product base layer for `ellamaka-tools`, injected in memory beneath user patches. */
export function toolsBasePatches(): unknown[] {
  if (!cachedToolsBasePatches) {
    const document = parseDocument(TOOLS_PROFILE_ROWS, { schema: DSH_PATCH_ENTRY_LIST_SCHEMA })
    if (document.errors.length > 0) {
      throw new Error(
        `ellamaka-cordis: invalid built-in tools composition: ${document.errors.map((e) => e.message).join("; ")}`,
      )
    }
    const items = (document.contents as { items?: unknown } | null)?.items
    if (!Array.isArray(items)) {
      throw new Error("ellamaka-cordis: built-in tools composition must be a YAML sequence")
    }
    cachedToolsBasePatches = items.map((row) => (row as { toJSON?: () => unknown }).toJSON?.() ?? row)
  }
  return structuredClone(cachedToolsBasePatches)
}
