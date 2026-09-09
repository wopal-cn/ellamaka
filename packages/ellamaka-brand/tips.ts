import { BINARY_NAME } from "./branding"

export type TipShortcut = () => string
export type Shortcuts = Record<string, TipShortcut>
export type Tip = string | ((shortcuts: Shortcuts) => string | undefined)

function highlight(text: string) {
  return `{highlight}${text}{/highlight}`
}

function press(shortcut: string, text: string) {
  if (!shortcut) return undefined
  return `Press ${highlight(shortcut)} ${text}`
}

function commandText(command: string, shortcut: string) {
  if (!shortcut) return highlight(command)
  return `${highlight(command)} or ${highlight(shortcut)}`
}

function shortcutText(value: string) {
  return highlight(value)
}

export const ELLAMAKA_TIPS: Tip[] = [
  "Type {highlight}@{/highlight} followed by a filename to fuzzy search and attach files",
  "Start a message with {highlight}!{/highlight} to run shell commands directly (e.g., {highlight}!ls -la{/highlight})",
  (s) => press(s.agentCycle(), "to cycle between Build and Plan agents"),
  "Use {highlight}/undo{/highlight} to revert the last message and file changes",
  "Use {highlight}/redo{/highlight} to restore previously undone messages and file changes",
  "Drag and drop images or PDFs into the terminal to add them as context",
  (s) => press(s.inputPaste(), "to paste images from your clipboard into the prompt"),
  (s) => `Use ${commandText("/editor", s.editorOpen())} to compose messages in your external editor`,
  "Run {highlight}/init{/highlight} to auto-generate project rules based on your codebase",
  (s) => `Use ${commandText("/models", s.modelList())} to see and switch between available AI models`,
  (s) => `Use ${commandText("/themes", s.themeList())} to switch between built-in themes`,
  (s) => `Use ${commandText("/new", s.sessionNew())} to start a fresh conversation session`,
  (s) => `Use ${commandText("/sessions", s.sessionList())} to list, pin, and continue sessions`,
  (s) => press(s.sessionPinToggle(), "in the session list to pin a session so it stays at the top"),
  (s) =>
    s.sessionQuickSwitch1() && s.sessionQuickSwitch9()
      ? `Pinned sessions are assigned quick slots; use ${shortcutText(s.sessionQuickSwitch1())} through ${shortcutText(s.sessionQuickSwitch9())} to switch`
      : undefined,
  "Run {highlight}/compact{/highlight} to summarize long sessions near context limits",
  (s) => `Use ${commandText("/export", s.sessionExport())} to save the conversation as Markdown`,
  (s) => press(s.messagesCopy(), "to copy the assistant's last message to clipboard"),
  (s) => press(s.commandList(), "to see all available actions and commands"),
  "Run {highlight}/connect{/highlight} to add API keys for 75+ supported LLM providers",
  (s) => `The leader key is ${shortcutText(s.leader())}; combine with other keys for quick actions`,
  (s) => press(s.modelCycleRecent(), "to quickly switch between recently used models"),
  (s) => press(s.sessionSidebarToggle(), "in a session to show or hide the sidebar panel"),
  (s) =>
    s.messagesPageUp() && s.messagesPageDown()
      ? `Use ${shortcutText(s.messagesPageUp())}/${shortcutText(s.messagesPageDown())} to navigate through conversation history`
      : undefined,
  (s) => press(s.messagesFirst(), "to jump to the beginning of the conversation"),
  (s) => press(s.messagesLast(), "to jump to the most recent message"),
  (s) => press(s.inputNewline(), "to add newlines in your prompt"),
  (s) => press(s.inputClear(), "when typing to clear the input field"),
  (s) => press(s.sessionInterrupt(), "to stop the AI mid-response"),
  "Switch to {highlight}Plan{/highlight} agent to get suggestions without making actual changes",
  "Use {highlight}@agent-name{/highlight} in prompts to invoke specialized subagents",
  (s) => {
    const items = [s.sessionParent(), s.childFirst(), s.childPrevious(), s.childNext()].filter(Boolean)
    if (!items.length) return undefined
    return `Use ${items.map(shortcutText).join(" / ")} to move between parent and child sessions`
  },
  `Configure all settings in {highlight}~/.wopal/config/settings.jsonc{/highlight}`,
  "Place global TUI settings under {highlight}tui{/highlight} in {highlight}~/.wopal/config/settings.jsonc{/highlight}",
  "Add {highlight}$schema{/highlight} to your config for autocomplete in your editor",
  "Configure {highlight}model{/highlight} in config to set your default model",
  "Override any keybind in {highlight}settings.jsonc{/highlight} via the {highlight}keybinds{/highlight} section",
  "Set any keybind to {highlight}none{/highlight} to disable it completely",
  "Configure local or remote MCP servers in the {highlight}mcp{/highlight} config section",
  "Add {highlight}.md{/highlight} files to {highlight}.opencode/commands/{/highlight} to define reusable custom prompts",
  "Use {highlight}$ARGUMENTS{/highlight}, {highlight}$1{/highlight}, {highlight}$2{/highlight} in custom commands for dynamic input",
  "Use backticks in commands to inject shell output (e.g., {highlight}`git status`{/highlight})",
  "Add {highlight}.md{/highlight} files to {highlight}.opencode/agents/{/highlight} for specialized AI personas",
  "Configure per-agent permissions for {highlight}edit{/highlight}, {highlight}bash{/highlight}, and {highlight}webfetch{/highlight} tools",
  'Use patterns like {highlight}"git *": "allow"{/highlight} for granular bash permissions',
  'Set {highlight}"rm -rf *": "deny"{/highlight} to block destructive commands',
  'Configure {highlight}"git push": "ask"{/highlight} to require approval before pushing',
  'Set {highlight}"formatter": true{/highlight} in config to enable built-in formatters like prettier, gofmt, and ruff',
  'Set {highlight}"formatter": false{/highlight} in config to disable formatters enabled by another config layer',
  "Define custom formatter commands with file extensions in config",
  'Set {highlight}"lsp": true{/highlight} in config to enable built-in LSP servers for code analysis',
  "Create {highlight}.ts{/highlight} files in {highlight}.opencode/tools/{/highlight} to define new LLM tools",
  "Tool definitions can invoke scripts written in Python, Go, etc",
  "Add {highlight}.ts{/highlight} files to {highlight}.opencode/plugins/{/highlight} for event hooks",
  "Use plugins to send OS notifications when sessions complete",
  "Create a plugin to prevent Ellamaka from reading sensitive files",
  `Use {highlight}${BINARY_NAME} run{/highlight} for non-interactive scripting`,
  `Use {highlight}${BINARY_NAME} --continue{/highlight} to resume the last session`,
  `Use {highlight}${BINARY_NAME} run -f file.ts{/highlight} to attach files via CLI`,
  "Use {highlight}--format json{/highlight} for machine-readable output in scripts",
  `Run {highlight}${BINARY_NAME} serve{/highlight} for headless API access`,
  `Use {highlight}${BINARY_NAME} run --attach{/highlight} to connect to a running server`,
  `Run {highlight}${BINARY_NAME} auth list{/highlight} to see all configured providers`,
  `Run {highlight}${BINARY_NAME} agent create{/highlight} for guided agent creation`,
  'Use {highlight}"theme": "system"{/highlight} to match your terminal\'s colors',
  "Create JSON theme files in {highlight}.opencode/themes/{/highlight} directory",
  "Themes support dark/light variants for both modes",
  "Use numeric xterm color codes 0-255 in custom theme JSON",
  "Use {highlight}{env:VAR_NAME}{/highlight} syntax to reference environment variables in config",
  "Use {highlight}{file:path}{/highlight} to include file contents in config values",
  "Use {highlight}instructions{/highlight} in config to load additional rules files",
  "Set agent {highlight}temperature{/highlight} from 0.0 (focused) to 1.0 (creative)",
  "Configure {highlight}steps{/highlight} to limit agentic iterations per request",
  'Set {highlight}"tools": {"bash": false}{/highlight} to disable specific tools',
  'Set {highlight}"mcp_*": false{/highlight} to disable all tools from an MCP server',
  "Override global tool settings per agent configuration",
  "Permission {highlight}doom_loop{/highlight} prevents infinite tool call loops",
  "Permission {highlight}external_directory{/highlight} protects files outside project",
  `Run {highlight}${BINARY_NAME} debug config{/highlight} to troubleshoot configuration`,
  "Use {highlight}--print-logs{/highlight} flag to see detailed logs in stderr",
  (s) => `Use ${commandText("/timeline", s.sessionTimeline())} to jump to specific messages`,
  (s) => press(s.messagesToggleConceal(), "to toggle code block visibility in messages"),
  (s) => `Use ${commandText("/status", s.statusView())} to see system status info`,
  "Enable {highlight}scroll_acceleration{/highlight} in {highlight}settings.jsonc{/highlight} for smooth macOS-style scrolling",
  (s) =>
    s.commandList()
      ? `Toggle username display in chat via the command palette (${shortcutText(s.commandList())})`
      : "Toggle username display in chat via the command palette",
  "Commit your project's {highlight}AGENTS.md{/highlight} file to Git for team sharing",
  "Use {highlight}/review{/highlight} to review uncommitted changes, branches, or PRs",
  (s) => `Use ${commandText("/help", s.helpShow())} to show the help dialog`,
  "Use {highlight}/rename{/highlight} to rename the current session",
  ...(typeof process !== "undefined" && process.platform === "win32"
    ? ([(s: Shortcuts) => press(s.inputUndo(), "to undo changes in your prompt")] satisfies Tip[])
    : ([
        (s: Shortcuts) => press(s.terminalSuspend(), "to suspend the terminal and return to your shell"),
      ] satisfies Tip[])),
]
