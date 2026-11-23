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

# Console Management System

Relevant source files

- [bun.lock](https://github.com/anomalyco/opencode/blob/7daea69e/bun.lock)
- [packages/console/app/package.json](https://github.com/anomalyco/opencode/blob/7daea69e/packages/console/app/package.json)
- [packages/console/core/package.json](https://github.com/anomalyco/opencode/blob/7daea69e/packages/console/core/package.json)
- [packages/console/function/package.json](https://github.com/anomalyco/opencode/blob/7daea69e/packages/console/function/package.json)
- [packages/console/mail/package.json](https://github.com/anomalyco/opencode/blob/7daea69e/packages/console/mail/package.json)
- [packages/desktop/package.json](https://github.com/anomalyco/opencode/blob/7daea69e/packages/desktop/package.json)
- [packages/function/package.json](https://github.com/anomalyco/opencode/blob/7daea69e/packages/function/package.json)
- [packages/opencode/package.json](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/package.json)
- [packages/plugin/package.json](https://github.com/anomalyco/opencode/blob/7daea69e/packages/plugin/package.json)
- [packages/sdk/js/package.json](https://github.com/anomalyco/opencode/blob/7daea69e/packages/sdk/js/package.json)
- [packages/web/package.json](https://github.com/anomalyco/opencode/blob/7daea69e/packages/web/package.json)
- [sdks/vscode/package.json](https://github.com/anomalyco/opencode/blob/7daea69e/sdks/vscode/package.json)

The Console Management System is a SaaS platform that provides managed access to OpenCode's AI services, specifically OpenCode Zen (40+ curated models) and OpenCode Go (open source models). It consists of a three-tier architecture deployed on Cloudflare infrastructure: a SolidStart frontend application, Cloudflare Workers backend API, and shared core business logic with database integration. The system handles user authentication, workspace management, payment processing via Stripe, usage tracking, and serves as a proxy for AI model requests.

For information about the main OpenCode CLI and server application, see [Core Application](https://deepwiki.com/anomalyco/opencode/2-core-application)
. For details about the frontend components, see [Console Frontend](https://deepwiki.com/anomalyco/opencode/7.3-console-frontend)
. For backend implementation details, see [Console Backend](https://deepwiki.com/anomalyco/opencode/7.2-console-backend)
.

## System Architecture

The Console system is organized into five interconnected packages that form a complete SaaS platform:

**Sources:** [packages/console/app/package.json1-46](https://github.com/anomalyco/opencode/blob/7daea69e/packages/console/app/package.json#L1-L46)
[packages/console/function/package.json1-31](https://github.com/anomalyco/opencode/blob/7daea69e/packages/console/function/package.json#L1-L31)
[packages/console/core/package.json1-52](https://github.com/anomalyco/opencode/blob/7daea69e/packages/console/core/package.json#L1-L52)

## Package Structure

The Console system consists of five interdependent packages:

| Package            | Path                        | Purpose                           | Key Dependencies                               |
| ------------------ | --------------------------- | --------------------------------- | ---------------------------------------------- |
| `console-app`      | `packages/console/app`      | SolidStart frontend application   | SolidStart, OpenAuth, Stripe.js, UI components |
| `console-function` | `packages/console/function` | Cloudflare Workers API backend    | Hono, AI SDK, OpenAuth                         |
| `console-core`     | `packages/console/core`     | Business logic and database layer | Drizzle ORM, Stripe, AWS STS                   |
| `console-mail`     | `packages/console/mail`     | Email template system             | JSX Email, React                               |
| `console-resource` | `packages/console/resource` | Shared TypeScript types           | Cloudflare Workers types                       |

**Sources:** [packages/console/app/package.json1-46](https://github.com/anomalyco/opencode/blob/7daea69e/packages/console/app/package.json#L1-L46)
[packages/console/function/package.json1-31](https://github.com/anomalyco/opencode/blob/7daea69e/packages/console/function/package.json#L1-L31)
[packages/console/core/package.json1-52](https://github.com/anomalyco/opencode/blob/7daea69e/packages/console/core/package.json#L1-L52)
[packages/console/mail/package.json1-22](https://github.com/anomalyco/opencode/blob/7daea69e/packages/console/mail/package.json#L1-L22)

## Database and Data Layer

### Database Schema Management

The `console-core` package uses Drizzle ORM to manage database schemas and operations. It supports both PlanetScale and standard Postgres databases:

The database management scripts are defined in [packages/console/core/package.json26-40](https://github.com/anomalyco/opencode/blob/7daea69e/packages/console/core/package.json#L26-L40)
and include:

- `db` - Run drizzle-kit commands
- `db-dev` - Run migrations against development stage
- `db-prod` - Run migrations against production stage
- `shell` - Access SST shell for direct database access
- `shell-dev` / `shell-prod` - Stage-specific shell access

**Sources:** [packages/console/core/package.json8-19](https://github.com/anomalyco/opencode/blob/7daea69e/packages/console/core/package.json#L8-L19)
[packages/console/core/package.json26-40](https://github.com/anomalyco/opencode/blob/7daea69e/packages/console/core/package.json#L26-L40)

### Core Business Logic

The `console-core` package provides centralized business logic accessible to both frontend and backend:

| Export Pattern | Description                                    |
| -------------- | ---------------------------------------------- |
| `./*.js`       | TypeScript source files compiled to JavaScript |
| `./*`          | Direct TypeScript source file imports          |

This allows both `console-app` and `console-function` to import shared logic directly from the source files. The core package handles:

- User account and workspace management
- Usage tracking and quota enforcement
- Payment and subscription logic via Stripe
- Model availability and configuration
- Email rendering and delivery

**Sources:** [packages/console/core/package.json21-24](https://github.com/anomalyco/opencode/blob/7daea69e/packages/console/core/package.json#L21-L24)

## API Backend (console-function)

### Request Routing

The `console-function` package implements a Cloudflare Workers backend using Hono for HTTP routing:

**Dependencies:**

- `hono` - HTTP framework for Cloudflare Workers
- `@hono/zod-validator` - Request validation middleware
- `@openauthjs/openauth` - Authentication middleware
- `@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/openai-compatible` - AI provider SDKs
- `ai` - Core AI SDK for streaming and tool calling

**Sources:** [packages/console/function/package.json19-29](https://github.com/anomalyco/opencode/blob/7daea69e/packages/console/function/package.json#L19-L29)

### Authentication Flow

The backend uses OpenAuth for session management:

**Sources:** [packages/console/function/package.json26](https://github.com/anomalyco/opencode/blob/7daea69e/packages/console/function/package.json#L26-L26)

## Frontend Application (console-app)

### Technology Stack

The `console-app` uses SolidStart with Vite for the frontend application:

| Technology             | Purpose                             |
| ---------------------- | ----------------------------------- |
| SolidStart             | Meta-framework for SolidJS with SSR |
| Vite                   | Build tool and dev server           |
| Cloudflare Vite Plugin | Cloudflare Workers integration      |
| OpenAuth               | Authentication client               |
| Stripe.js              | Payment form integration            |
| Chart.js               | Usage analytics visualization       |

**Build Process:**

The build script [packages/console/app/package.json10](https://github.com/anomalyco/opencode/blob/7daea69e/packages/console/app/package.json#L10-L10)
performs three steps:

1.  Generate sitemap via `./script/generate-sitemap.ts`
2.  Build the Vite application
3.  Generate OpenCode configuration schemas using the main opencode CLI

**Sources:** [packages/console/app/package.json13-35](https://github.com/anomalyco/opencode/blob/7daea69e/packages/console/app/package.json#L13-L35)
[packages/console/app/package.json10](https://github.com/anomalyco/opencode/blob/7daea69e/packages/console/app/package.json#L10-L10)

### Component Architecture

**Sources:** [packages/console/app/package.json13-35](https://github.com/anomalyco/opencode/blob/7daea69e/packages/console/app/package.json#L13-L35)

### Development Configuration

Development modes support both local and remote API configurations:

| Script       | Environment | Purpose                                                 |
| ------------ | ----------- | ------------------------------------------------------- |
| `dev`        | Local       | Development server on `0.0.0.0`                         |
| `dev:remote` | Remote      | Connect to `auth.dev.opencode.ai` with test Stripe keys |

The remote development mode [packages/console/app/package.json9](https://github.com/anomalyco/opencode/blob/7daea69e/packages/console/app/package.json#L9-L9)
uses SST shell to inject environment variables for the development stage.

**Sources:** [packages/console/app/package.json6-11](https://github.com/anomalyco/opencode/blob/7daea69e/packages/console/app/package.json#L6-L11)

## Email System (console-mail)

### Email Template Architecture

The `console-mail` package uses JSX Email for rendering HTML emails:

**Export Pattern:**

Templates are exported with the pattern `./*` mapping to `./emails/templates/*` [packages/console/mail/package.json12-14](https://github.com/anomalyco/opencode/blob/7daea69e/packages/console/mail/package.json#L12-L14)
allowing consumers to import specific templates:

**Development:**

The preview server [packages/console/mail/package.json18](https://github.com/anomalyco/opencode/blob/7daea69e/packages/console/mail/package.json#L18-L18)
provides a live development environment:

**Sources:** [packages/console/mail/package.json1-22](https://github.com/anomalyco/opencode/blob/7daea69e/packages/console/mail/package.json#L1-L22)

## Resource Types (console-resource)

The `console-resource` package provides shared TypeScript type definitions used across the Console system:

| Dependency                  | Purpose                              |
| --------------------------- | ------------------------------------ |
| `@cloudflare/workers-types` | Cloudflare Workers environment types |
| `cloudflare` (dev)          | Cloudflare API type generation       |

This package defines common interfaces for:

- Workspace and user models
- API request/response schemas
- Configuration structures
- Cloudflare-specific resource types

Both `console-app` and `console-function` import these types to ensure type safety across the frontend-backend boundary.

**Sources:** [packages/console/resource/package.json1-12](https://github.com/anomalyco/opencode/blob/7daea69e/packages/console/resource/package.json#L1-L12)
(implied from bun.lock)

## Model and Limit Management

### Model Configuration

The `console-core` package includes scripts for managing AI model availability:

**Workflow:**

1.  Update local model configuration with `update-models`
2.  Test locally and promote to dev with `promote-models-to-dev`
3.  Validate in staging, then promote to production with `promote-models-to-prod`
4.  Pull production config back for reference with `pull-models-from-prod`

**Sources:** [packages/console/core/package.json32-36](https://github.com/anomalyco/opencode/blob/7daea69e/packages/console/core/package.json#L32-L36)

### Rate Limit Configuration

Similar scripts manage usage limits and quotas:

These scripts [packages/console/core/package.json37-39](https://github.com/anomalyco/opencode/blob/7daea69e/packages/console/core/package.json#L37-L39)
control:

- Request rate limits per user/workspace
- Token usage quotas
- Concurrent request limits
- Model-specific restrictions

**Sources:** [packages/console/core/package.json37-39](https://github.com/anomalyco/opencode/blob/7daea69e/packages/console/core/package.json#L37-L39)

## Payment Integration

### Stripe Configuration

The Console system integrates Stripe for payment processing:

**Backend (console-core):**

- `stripe` package - Server-side Stripe SDK for payment processing
- Handles webhook events, subscription management, usage-based billing

**Frontend (console-app):**

- `@stripe/stripe-js` - Stripe.js library for client-side payment forms
- `solid-stripe` - SolidJS wrapper for Stripe Elements

The frontend uses the Stripe publishable key configured via `VITE_STRIPE_PUBLISHABLE_KEY` [packages/console/app/package.json9](https://github.com/anomalyco/opencode/blob/7daea69e/packages/console/app/package.json#L9-L9)
while the backend uses the secret key from SST environment configuration.

**Sources:** [packages/console/core/package.json17](https://github.com/anomalyco/opencode/blob/7daea69e/packages/console/core/package.json#L17-L17)
[packages/console/app/package.json28](https://github.com/anomalyco/opencode/blob/7daea69e/packages/console/app/package.json#L28-L28)

## Deployment Architecture

### SST Infrastructure

The Console platform uses SST (Serverless Stack) for infrastructure management:

**Stage Management:**

SST supports multiple deployment stages:

- `dev` - Development stage for testing
- `production` - Production stage for live traffic

Shell commands provide environment access [packages/console/core/package.json29-31](https://github.com/anomalyco/opencode/blob/7daea69e/packages/console/core/package.json#L29-L31)
:

**Sources:** [packages/console/core/package.json26-31](https://github.com/anomalyco/opencode/blob/7daea69e/packages/console/core/package.json#L26-L31)
[packages/console/app/package.json9](https://github.com/anomalyco/opencode/blob/7daea69e/packages/console/app/package.json#L9-L9)

### Build and Deployment Process

The build process [packages/console/app/package.json10](https://github.com/anomalyco/opencode/blob/7daea69e/packages/console/app/package.json#L10-L10)
generates OpenCode configuration schemas and places them in the public output directory, making them available to frontend clients for configuration validation.

**Sources:** [packages/console/app/package.json10](https://github.com/anomalyco/opencode/blob/7daea69e/packages/console/app/package.json#L10-L10)

## Analytics and Monitoring

### Usage Tracking

The `console-app` includes Chart.js [packages/console/app/package.json29](https://github.com/anomalyco/opencode/blob/7daea69e/packages/console/app/package.json#L29-L29)
for visualizing:

- Token usage over time
- Request volume per workspace
- Model usage distribution
- Cost analytics

### Event Streaming

The system uses Smithy event stream codec [packages/console/app/package.json23-24](https://github.com/anomalyco/opencode/blob/7daea69e/packages/console/app/package.json#L23-L24)
for real-time event processing:

- `@smithy/eventstream-codec` - Binary event stream encoding
- `@smithy/util-utf8` - UTF-8 encoding utilities

This enables streaming responses from AI providers through the Cloudflare Workers backend to the frontend.

**Sources:** [packages/console/app/package.json23-29](https://github.com/anomalyco/opencode/blob/7daea69e/packages/console/app/package.json#L23-L29)

Dismiss

Refresh this wiki

Enter email to refresh

### On this page

- [Console Management System](https://deepwiki.com/anomalyco/opencode/7-console-management-system#console-management-system)
- [System Architecture](https://deepwiki.com/anomalyco/opencode/7-console-management-system#system-architecture)
- [Package Structure](https://deepwiki.com/anomalyco/opencode/7-console-management-system#package-structure)
- [Database and Data Layer](https://deepwiki.com/anomalyco/opencode/7-console-management-system#database-and-data-layer)
- [Database Schema Management](https://deepwiki.com/anomalyco/opencode/7-console-management-system#database-schema-management)
- [Core Business Logic](https://deepwiki.com/anomalyco/opencode/7-console-management-system#core-business-logic)
- [API Backend (console-function)](https://deepwiki.com/anomalyco/opencode/7-console-management-system#api-backend-console-function)
- [Request Routing](https://deepwiki.com/anomalyco/opencode/7-console-management-system#request-routing)
- [Authentication Flow](https://deepwiki.com/anomalyco/opencode/7-console-management-system#authentication-flow)
- [Frontend Application (console-app)](https://deepwiki.com/anomalyco/opencode/7-console-management-system#frontend-application-console-app)
- [Technology Stack](https://deepwiki.com/anomalyco/opencode/7-console-management-system#technology-stack)
- [Component Architecture](https://deepwiki.com/anomalyco/opencode/7-console-management-system#component-architecture)
- [Development Configuration](https://deepwiki.com/anomalyco/opencode/7-console-management-system#development-configuration)
- [Email System (console-mail)](https://deepwiki.com/anomalyco/opencode/7-console-management-system#email-system-console-mail)
- [Email Template Architecture](https://deepwiki.com/anomalyco/opencode/7-console-management-system#email-template-architecture)
- [Resource Types (console-resource)](https://deepwiki.com/anomalyco/opencode/7-console-management-system#resource-types-console-resource)
- [Model and Limit Management](https://deepwiki.com/anomalyco/opencode/7-console-management-system#model-and-limit-management)
- [Model Configuration](https://deepwiki.com/anomalyco/opencode/7-console-management-system#model-configuration)
- [Rate Limit Configuration](https://deepwiki.com/anomalyco/opencode/7-console-management-system#rate-limit-configuration)
- [Payment Integration](https://deepwiki.com/anomalyco/opencode/7-console-management-system#payment-integration)
- [Stripe Configuration](https://deepwiki.com/anomalyco/opencode/7-console-management-system#stripe-configuration)
- [Deployment Architecture](https://deepwiki.com/anomalyco/opencode/7-console-management-system#deployment-architecture)
- [SST Infrastructure](https://deepwiki.com/anomalyco/opencode/7-console-management-system#sst-infrastructure)
- [Build and Deployment Process](https://deepwiki.com/anomalyco/opencode/7-console-management-system#build-and-deployment-process)
- [Analytics and Monitoring](https://deepwiki.com/anomalyco/opencode/7-console-management-system#analytics-and-monitoring)
- [Usage Tracking](https://deepwiki.com/anomalyco/opencode/7-console-management-system#usage-tracking)
- [Event Streaming](https://deepwiki.com/anomalyco/opencode/7-console-management-system#event-streaming)
