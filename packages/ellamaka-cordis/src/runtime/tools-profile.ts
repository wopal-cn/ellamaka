/** Standard DSH YAML rows for the session-free tools container. */
export const TOOLS_PROFILE_ROWS = `# Ellamaka session-free tools composition. Standard DSH profile patch syntax.
- insert:
    - id: timer
      name: '@deepseek-ai/cordis-plugin-timer'
    - id: session-projection
      name: '@deepseek-ai/dsh-session-projection'
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
    - id: tool-fs
      name: '@deepseek-ai/dsh-tool-fs'
    - id: tool-fs-search
      name: '@deepseek-ai/dsh-tool-fs-search'
      config:
        sampleOverCapGlobResults: false
    - id: ptc-runtime
      name: '@deepseek-ai/dsh-ptc-runtime-node'
    - id: timeout-policy
      name: '@deepseek-ai/dsh-tool-call-timeout-policy'
    - id: spill-local
      name: '@deepseek-ai/dsh-spill-local'
    - id: spill-policy
      name: '@deepseek-ai/dsh-spill-policy'
    - id: tools
      name: '@deepseek-ai/dsh-tools'
      config:
        mode: native
    - id: system-prompt
      name: '@deepseek-ai/dsh-system-prompt'
      config:
        personaPrefix: ''
    - id: fs-sandbox
      name: '@deepseek-ai/dsh-fs-sandbox'
    - id: tool-str-replace-editor
      name: '@deepseek-ai/dsh-tool-str-replace-editor'

`

export const TOOLS_PROFILE_BLOCK_BEGIN =
  "# >>> ellamaka-tools composition (product-owned; refreshed with the DSH closure)\n"
export const TOOLS_PROFILE_BLOCK_END = "# <<< ellamaka-tools composition\n"

/** The complete product-owned block written into the profile patch layer. */
export const TOOLS_PROFILE_BLOCK = TOOLS_PROFILE_BLOCK_BEGIN + TOOLS_PROFILE_ROWS + TOOLS_PROFILE_BLOCK_END
