Loading...

Index your code with Devin

[DeepWiki](https://deepwiki.com/)

[DeepWiki](https://deepwiki.com/)

[anomalyco/opencode](https://github.com/anomalyco/opencode "Open repository")

Index your code with

Devin

Edit WikiShare

Loading...

Last indexed: 17 March 2026 ([7daea6](https://github.com/anomalyco/opencode/commits/7daea69e)
)

- [Overview](https://deepwiki.com/anomalyco/opencode/1-overview)
- [Repository Structure & Packages](https://deepwiki.com/anomalyco/opencode/1.1-repository-structure-and-packages)
- [Architecture Overview](https://deepwiki.com/anomalyco/opencode/1.2-architecture-overview)
- [Core Application](https://deepwiki.com/anomalyco/opencode/2-core-application)
- [CLI Entrypoint & Commands](https://deepwiki.com/anomalyco/opencode/2.1-cli-entrypoint-and-commands)
- [Configuration System](https://deepwiki.com/anomalyco/opencode/2.2-configuration-system)
- [Session & Agent System](https://deepwiki.com/anomalyco/opencode/2.3-session-and-agent-system)
- [AI Provider & Model Management](https://deepwiki.com/anomalyco/opencode/2.4-ai-provider-and-model-management)
- [Tool System & Permissions](https://deepwiki.com/anomalyco/opencode/2.5-tool-system-and-permissions)
- [HTTP Server & REST API](https://deepwiki.com/anomalyco/opencode/2.6-http-server-and-rest-api)
- [Event Bus & Real-time Updates](https://deepwiki.com/anomalyco/opencode/2.7-event-bus-and-real-time-updates)
- [LSP & Code Formatting](https://deepwiki.com/anomalyco/opencode/2.8-lsp-and-code-formatting)
- [Plugin System](https://deepwiki.com/anomalyco/opencode/2.9-plugin-system)
- [MCP Integration](https://deepwiki.com/anomalyco/opencode/2.10-mcp-integration)
- [Skills & Command System](https://deepwiki.com/anomalyco/opencode/2.11-skills-and-command-system)
- [User Interfaces](https://deepwiki.com/anomalyco/opencode/3-user-interfaces)
- [Terminal User Interface (TUI)](<https://deepwiki.com/anomalyco/opencode/3.1-terminal-user-interface-(tui)>)
- [Web Application](https://deepwiki.com/anomalyco/opencode/3.2-web-application)
- [Desktop Applications](https://deepwiki.com/anomalyco/opencode/3.3-desktop-applications)
- [UI Component Library](https://deepwiki.com/anomalyco/opencode/4-ui-component-library)
- [Component Architecture & Exports](https://deepwiki.com/anomalyco/opencode/4.1-component-architecture-and-exports)
- [Session Turn & Message Rendering](https://deepwiki.com/anomalyco/opencode/4.2-session-turn-and-message-rendering)
- [Styling System & Themes](https://deepwiki.com/anomalyco/opencode/4.3-styling-system-and-themes)
- [SDK & API](https://deepwiki.com/anomalyco/opencode/5-sdk-and-api)
- [JavaScript SDK](https://deepwiki.com/anomalyco/opencode/5.1-javascript-sdk)
- [OpenAPI Specification & Code Generation](https://deepwiki.com/anomalyco/opencode/5.2-openapi-specification-and-code-generation)
- [IDE Extensions & Integrations](https://deepwiki.com/anomalyco/opencode/6-ide-extensions-and-integrations)
- [VS Code Extension](https://deepwiki.com/anomalyco/opencode/6.1-vs-code-extension)
- [Zed Extension](https://deepwiki.com/anomalyco/opencode/6.2-zed-extension)
- [Slack Integration](https://deepwiki.com/anomalyco/opencode/6.3-slack-integration)
- [Console Management System](https://deepwiki.com/anomalyco/opencode/7-console-management-system)
- [Console Architecture](https://deepwiki.com/anomalyco/opencode/7.1-console-architecture)
- [Console Backend](https://deepwiki.com/anomalyco/opencode/7.2-console-backend)
- [Console Frontend](https://deepwiki.com/anomalyco/opencode/7.3-console-frontend)
- [Build & Release](https://deepwiki.com/anomalyco/opencode/8-build-and-release)
- [Release Pipeline](https://deepwiki.com/anomalyco/opencode/8.1-release-pipeline)
- [Nix Builds](https://deepwiki.com/anomalyco/opencode/8.2-nix-builds)
- [Reference](https://deepwiki.com/anomalyco/opencode/9-reference)
- [Providers & Models](https://deepwiki.com/anomalyco/opencode/9.1-providers-and-models)
- [TUI Commands & Keybindings](https://deepwiki.com/anomalyco/opencode/9.2-tui-commands-and-keybindings)
- [Configuration Schema Reference](https://deepwiki.com/anomalyco/opencode/9.3-configuration-schema-reference)

Menu

# Reference

Relevant source files

- [README.md](https://github.com/anomalyco/opencode/blob/7daea69e/README.md?plain=1)
- [packages/opencode/script/schema.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/script/schema.ts)
- [packages/opencode/src/auth/index.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/auth/index.ts)
- [packages/opencode/src/auth/service.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/auth/service.ts)
- [packages/opencode/src/cli/ui.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/cli/ui.ts)
- [packages/opencode/test/provider/amazon-bedrock.test.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/test/provider/amazon-bedrock.test.ts)
- [packages/opencode/test/provider/gitlab-duo.test.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/test/provider/gitlab-duo.test.ts)
- [packages/web/src/components/Lander.astro](https://github.com/anomalyco/opencode/blob/7daea69e/packages/web/src/components/Lander.astro)
- [packages/web/src/content/docs/go.mdx](https://github.com/anomalyco/opencode/blob/7daea69e/packages/web/src/content/docs/go.mdx?plain=1)
- [packages/web/src/content/docs/index.mdx](https://github.com/anomalyco/opencode/blob/7daea69e/packages/web/src/content/docs/index.mdx?plain=1)
- [packages/web/src/content/docs/providers.mdx](https://github.com/anomalyco/opencode/blob/7daea69e/packages/web/src/content/docs/providers.mdx?plain=1)
- [packages/web/src/content/docs/zen.mdx](https://github.com/anomalyco/opencode/blob/7daea69e/packages/web/src/content/docs/zen.mdx?plain=1)

This page provides quick reference documentation for common OpenCode tasks, configurations, and command patterns. It covers the most frequently accessed information needed when working with OpenCode.

For comprehensive provider and model listings, see [Providers & Models](https://deepwiki.com/anomalyco/opencode/9.1-providers-and-models)
. For TUI-specific commands and keybindings, see [TUI Commands & Keybindings](https://deepwiki.com/anomalyco/opencode/9.2-tui-commands-and-keybindings)
. For complete configuration schema documentation, see [Configuration Schema Reference](https://deepwiki.com/anomalyco/opencode/9.3-configuration-schema-reference)
.

---

## Common Tasks

### Installation

OpenCode can be installed through multiple package managers:

| Method         | Command                                          |
| -------------- | ------------------------------------------------ |
| Install script | `curl -fsSL https://opencode.ai/install \| bash` |
| npm            | `npm install -g opencode-ai`                     |
| Bun            | `bun install -g opencode-ai`                     |
| Homebrew       | `brew install anomalyco/tap/opencode`            |
| Arch Linux     | `sudo pacman -S opencode`                        |
| AUR            | `paru -S opencode-bin`                           |
| Chocolatey     | `choco install opencode`                         |
| Scoop          | `scoop install opencode`                         |
| Docker         | `docker run -it --rm ghcr.io/anomalyco/opencode` |
| Nix            | `nix run nixpkgs#opencode`                       |

**Sources:** [README.md46-62](https://github.com/anomalyco/opencode/blob/7daea69e/README.md?plain=1#L46-L62)
[packages/web/src/content/docs/index.mdx32-129](https://github.com/anomalyco/opencode/blob/7daea69e/packages/web/src/content/docs/index.mdx?plain=1#L32-L129)

### Authentication Setup

Connect to a provider using the `/connect` command in the TUI:

This command guides you through selecting a provider and configuring credentials. Authentication data is stored in `~/.local/share/opencode/auth.json`.

**Sources:** [packages/web/src/content/docs/index.mdx134-159](https://github.com/anomalyco/opencode/blob/7daea69e/packages/web/src/content/docs/index.mdx?plain=1#L134-L159)
[packages/opencode/src/auth/service.ts36](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/auth/service.ts#L36-L36)

### Model Selection

Select or change the active model using the `/models` command:

**Sources:** [packages/web/src/content/docs/providers.mdx77-81](https://github.com/anomalyco/opencode/blob/7daea69e/packages/web/src/content/docs/providers.mdx?plain=1#L77-L81)

---

## Authentication System

OpenCode supports three authentication methods for providers: OAuth, API keys, and well-known authentication.

**Authentication Type Definitions**

The `Auth.Info` discriminated union supports three authentication types:

| Type        | Properties                                                     | Use Case                                                |
| ----------- | -------------------------------------------------------------- | ------------------------------------------------------- |
| `oauth`     | `refresh`, `access`, `expires`, `accountId?`, `enterpriseUrl?` | OAuth 2.0 providers (Anthropic, GitHub Copilot, GitLab) |
| `api`       | `key`                                                          | API key-based providers (OpenAI, most providers)        |
| `wellknown` | `key`, `token`                                                 | Well-known authentication endpoints                     |

**Sources:** [packages/opencode/src/auth/index.ts13-39](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/auth/index.ts#L13-L39)
[packages/opencode/src/auth/service.ts8-29](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/auth/service.ts#L8-L29)

---

## Provider Configuration

Providers are configured through a hierarchical system combining `opencode.json`, `auth.json`, and environment variables.

**Configuration Precedence**

For most provider options, the precedence order is:

1.  `opencode.json` provider config (`provider.[id].options`)
2.  Environment variables (provider-specific)
3.  Default values

**Special Cases:**

- **Amazon Bedrock**: Bearer token from `auth.json` or `AWS_BEARER_TOKEN_BEDROCK` takes precedence over AWS credential chain
- **GitLab**: `options.apiKey` in config takes precedence over `GITLAB_TOKEN` environment variable
- **Azure**: `AZURE_RESOURCE_NAME` environment variable is required

**Sources:** [packages/web/src/content/docs/providers.mdx26-48](https://github.com/anomalyco/opencode/blob/7daea69e/packages/web/src/content/docs/providers.mdx?plain=1#L26-L48)
[packages/opencode/test/provider/amazon-bedrock.test.ts12-42](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/test/provider/amazon-bedrock.test.ts#L12-L42)
[packages/opencode/test/provider/gitlab-duo.test.ts171-199](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/test/provider/gitlab-duo.test.ts#L171-L199)

---

## File Locations

OpenCode uses several well-defined file locations for configuration and data storage:

| File              | Path                                | Purpose                                              |
| ----------------- | ----------------------------------- | ---------------------------------------------------- |
| Authentication    | `~/.local/share/opencode/auth.json` | Stores provider credentials (OAuth tokens, API keys) |
| Global Config     | `~/.config/opencode/opencode.json`  | User-level configuration                             |
| Project Config    | `./opencode.json`                   | Project-specific configuration                       |
| Project Agents    | `./AGENTS.md`                       | Project analysis and patterns (generated by `/init`) |
| Config Schema     | `https://opencode.ai/config.json`   | JSON schema for configuration validation             |
| TUI Config Schema | `https://opencode.ai/tui.json`      | JSON schema for TUI-specific configuration           |

**Sources:** [packages/opencode/src/auth/service.ts36](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/auth/service.ts#L36-L36)
[packages/web/src/content/docs/index.mdx177-192](https://github.com/anomalyco/opencode/blob/7daea69e/packages/web/src/content/docs/index.mdx?plain=1#L177-L192)

---

## Environment Variables

### Provider-Specific Variables

| Provider                 | Variable                                 | Purpose                                |
| ------------------------ | ---------------------------------------- | -------------------------------------- |
| Amazon Bedrock           | `AWS_REGION`                             | AWS region for Bedrock                 |
| Amazon Bedrock           | `AWS_PROFILE`                            | AWS named profile                      |
| Amazon Bedrock           | `AWS_ACCESS_KEY_ID`                      | AWS access key                         |
| Amazon Bedrock           | `AWS_SECRET_ACCESS_KEY`                  | AWS secret key                         |
| Amazon Bedrock           | `AWS_BEARER_TOKEN_BEDROCK`               | Bedrock bearer token                   |
| Amazon Bedrock           | `AWS_WEB_IDENTITY_TOKEN_FILE`            | EKS IRSA token file path               |
| Amazon Bedrock           | `AWS_ROLE_ARN`                           | AWS role ARN for IRSA                  |
| Azure OpenAI             | `AZURE_RESOURCE_NAME`                    | Azure resource name                    |
| Azure Cognitive Services | `AZURE_COGNITIVE_SERVICES_RESOURCE_NAME` | Azure Cognitive Services resource name |
| Cloudflare AI Gateway    | `CLOUDFLARE_ACCOUNT_ID`                  | Cloudflare account ID                  |
| Cloudflare AI Gateway    | `CLOUDFLARE_GATEWAY_ID`                  | Cloudflare gateway ID                  |
| Cloudflare AI Gateway    | `CLOUDFLARE_API_TOKEN`                   | Cloudflare API token                   |
| GitLab Duo               | `GITLAB_TOKEN`                           | GitLab personal access token           |
| GitLab Duo               | `GITLAB_INSTANCE_URL`                    | Self-hosted GitLab instance URL        |
| GitLab Duo               | `GITLAB_AI_GATEWAY_URL`                  | Custom AI gateway URL                  |
| GitLab Duo               | `GITLAB_OAUTH_CLIENT_ID`                 | OAuth client ID for self-hosted        |
| Google Vertex AI         | `GOOGLE_CLOUD_PROJECT`                   | Google Cloud project ID                |
| Google Vertex AI         | `GOOGLE_APPLICATION_CREDENTIALS`         | Path to service account JSON           |
| Google Vertex AI         | `VERTEX_LOCATION`                        | Vertex AI region (default: `global`)   |

### Installation Variables

| Variable               | Purpose                        | Default Fallback                                     |
| ---------------------- | ------------------------------ | ---------------------------------------------------- |
| `OPENCODE_INSTALL_DIR` | Custom installation directory  | `$XDG_BIN_DIR` → `$HOME/bin` → `$HOME/.opencode/bin` |
| `XDG_BIN_DIR`          | XDG-compliant binary directory | `$HOME/bin`                                          |

**Sources:** [packages/web/src/content/docs/providers.mdx176-256](https://github.com/anomalyco/opencode/blob/7daea69e/packages/web/src/content/docs/providers.mdx?plain=1#L176-L256)
[README.md86-98](https://github.com/anomalyco/opencode/blob/7daea69e/README.md?plain=1#L86-L98)

---

## Common Commands

### TUI Slash Commands

| Command    | Purpose                                                   |
| ---------- | --------------------------------------------------------- |
| `/init`    | Initialize OpenCode for the project (creates `AGENTS.md`) |
| `/connect` | Configure provider authentication                         |
| `/models`  | Select or change the active model                         |
| `/share`   | Generate a shareable link for the current conversation    |
| `/undo`    | Revert the last set of changes                            |
| `/redo`    | Re-apply previously undone changes                        |

For a complete reference of TUI commands and keybindings, see [TUI Commands & Keybindings](https://deepwiki.com/anomalyco/opencode/9.2-tui-commands-and-keybindings)
.

**Sources:** [packages/web/src/content/docs/index.mdx177-344](https://github.com/anomalyco/opencode/blob/7daea69e/packages/web/src/content/docs/index.mdx?plain=1#L177-L344)

---

## UI Output Styles

The `UI` namespace in the CLI provides standardized output formatting:

| Style Constant            | ANSI Code                                                                        | Use Case                           |
| ------------------------- | -------------------------------------------------------------------------------- | ---------------------------------- |
| `UI.Style.TEXT_HIGHLIGHT` | `\x1b<FileRef file-url="https://github.com/anomalyco/opencode/blob/7daea69e/96m` | Highlighting important text (cyan) |

---

## OpenCode Services

OpenCode provides two managed services for model access:

### OpenCode Zen

Pay-as-you-go access to 40+ curated models. Pricing per 1M tokens ranges from free models to premium options.

- **Endpoint Format**: `https://opencode.ai/zen/v1/...`
- **Model ID Format**: `opencode/<model-id>`
- **Auto-reload**: Reloads $20 when balance drops below $5 (configurable)
- **Free Models**: Big Pickle, MiMo V2 Flash Free, Nemotron 3 Super Free, MiniMax M2.5 Free

### OpenCode Go

Low-cost subscription ($5 first month, $10/month) for reliable access to popular open models.

- **Endpoint Format**: `https://opencode.ai/zen/go/v1/...`
- **Model ID Format**: `opencode-go/<model-id>`
- **Models**: GLM-5, Kimi K2.5, MiniMax M2.5
- **Limits**:
  - 5 hour limit: $12 of usage
  - Weekly limit: $30 of usage
  - Monthly limit: $60 of usage

**Sources:** [packages/web/src/content/docs/zen.mdx10-104](https://github.com/anomalyco/opencode/blob/7daea69e/packages/web/src/content/docs/zen.mdx?plain=1#L10-L104)
[packages/web/src/content/docs/go.mdx10-129](https://github.com/anomalyco/opencode/blob/7daea69e/packages/web/src/content/docs/go.mdx?plain=1#L10-L129)

---

## Configuration Schema Generation

OpenCode uses Zod schemas to generate JSON schemas for configuration validation:

**Schema Generation Features:**

- `io: "input"` mode treats `optional().default()` fields as not required
- `additionalProperties: false` enforces strict object validation
- Default values are included in the `examples` array
- Descriptions are enriched with default value documentation
- `allowComments` and `allowTrailingCommas` enable JSONC support

**Sources:** [packages/opencode/script/schema.ts7-63](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/script/schema.ts#L7-L63)

---

## Provider Authentication Methods

Different providers support different authentication methods:

| Provider         | OAuth              | API Key                   | Environment Variables | Special Config                  |
| ---------------- | ------------------ | ------------------------- | --------------------- | ------------------------------- |
| Anthropic        | ✓ (Claude Pro/Max) | ✓                         | \-                    | \-                              |
| OpenAI           | \-                 | ✓                         | \-                    | \-                              |
| GitHub Copilot   | ✓ (device flow)    | \-                        | \-                    | \-                              |
| GitLab Duo       | ✓                  | ✓ (Personal Access Token) | `GITLAB_TOKEN`        | `instanceUrl`, `featureFlags`   |
| Amazon Bedrock   | \-                 | ✓ (bearer token)          | `AWS_*`               | `region`, `profile`, `endpoint` |
| Azure OpenAI     | \-                 | ✓                         | `AZURE_RESOURCE_NAME` | \-                              |
| Google Vertex AI | \-                 | \-                        | `GOOGLE_*`            | Service account JSON            |
| Ollama           | \-                 | \-                        | \-                    | Local server                    |

**OAuth Dummy Key**: When OAuth authentication is used, the provider's `key` field is set to `OAUTH_DUMMY_KEY` constant (`"opencode-oauth-dummy-key"`).

**Sources:** [packages/web/src/content/docs/providers.mdx296-903](https://github.com/anomalyco/opencode/blob/7daea69e/packages/web/src/content/docs/providers.mdx?plain=1#L296-L903)
[packages/opencode/src/auth/service.ts6](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/auth/service.ts#L6-L6)

Dismiss

Refresh this wiki

Enter email to refresh

### On this page

- [Reference](https://deepwiki.com/anomalyco/opencode/9-reference#reference)
- [Common Tasks](https://deepwiki.com/anomalyco/opencode/9-reference#common-tasks)
- [Installation](https://deepwiki.com/anomalyco/opencode/9-reference#installation)
- [Authentication Setup](https://deepwiki.com/anomalyco/opencode/9-reference#authentication-setup)
- [Model Selection](https://deepwiki.com/anomalyco/opencode/9-reference#model-selection)
- [Authentication System](https://deepwiki.com/anomalyco/opencode/9-reference#authentication-system)
- [Provider Configuration](https://deepwiki.com/anomalyco/opencode/9-reference#provider-configuration)
- [File Locations](https://deepwiki.com/anomalyco/opencode/9-reference#file-locations)
- [Environment Variables](https://deepwiki.com/anomalyco/opencode/9-reference#environment-variables)
- [Provider-Specific Variables](https://deepwiki.com/anomalyco/opencode/9-reference#provider-specific-variables)
- [Installation Variables](https://deepwiki.com/anomalyco/opencode/9-reference#installation-variables)
- [Common Commands](https://deepwiki.com/anomalyco/opencode/9-reference#common-commands)
- [TUI Slash Commands](https://deepwiki.com/anomalyco/opencode/9-reference#tui-slash-commands)
- [UI Output Styles](https://deepwiki.com/anomalyco/opencode/9-reference#ui-output-styles)
- [OpenCode Services](https://deepwiki.com/anomalyco/opencode/9-reference#opencode-services)
- [OpenCode Zen](https://deepwiki.com/anomalyco/opencode/9-reference#opencode-zen)
- [OpenCode Go](https://deepwiki.com/anomalyco/opencode/9-reference#opencode-go)
- [Configuration Schema Generation](https://deepwiki.com/anomalyco/opencode/9-reference#configuration-schema-generation)
- [Provider Authentication Methods](https://deepwiki.com/anomalyco/opencode/9-reference#provider-authentication-methods)
