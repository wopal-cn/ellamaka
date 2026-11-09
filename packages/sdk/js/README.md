# @wopal/ellamaka-sdk

The public Platform SDK for an existing Ellamaka Server.

```ts
import { createEllamakaClient } from "@wopal/ellamaka-sdk/http"

const client = createEllamakaClient({
  baseUrl: "http://127.0.0.1:4096",
  directory: "/path/to/project",
})

const health = await client.global.health()
const sessions = await client.session.list()
```

`@wopal/ellamaka-sdk/http` uses the canonical generated client for Runtime and WopalSpace operations. The root entrypoint exposes the same client plus the `createEllamakaServer`, `createEllamakaTui`, and `createEllamaka` host helpers. Importing the root does not start a process.

## Contract discovery

A running Server serves its complete mounted API at `GET /doc`. The document labels each operation with `x-ellamaka-audience`:

- `public-platform`: covered by this package's SemVer and available through this client;
- `official-app`: private App BFF operations used only by the official `ellamaka-app` client.

The package's public contract is available as:

```ts
import { openapi } from "@wopal/ellamaka-sdk/openapi"
// or read @wopal/ellamaka-sdk/openapi.json
```

This contract is the public subset of `GET /doc`; it does not contain Official App BFF operations. Every operation includes a purpose, authentication requirement, compatibility marker, parameter/request/response schemas, errors, and schema-valid examples.

## Compatibility

The root entrypoint now follows the canonical flat v2 call shape. Code that used the old root nested `path`/`body` arguments must move to `/v2` or `/http` and update calls such as:

```ts
// Before: root v1-shaped call
await client.session.get({ path: { id: sessionID } })

// Canonical
await client.session.get({ sessionID })
```

`@wopal/ellamaka-sdk/client`, `/server`, and `/v2/*` remain available for existing consumers. The compatibility adapter for `PluginInput.client` remains in `@wopal/ellamaka-plugin` and keeps the old nested shape for plugin authors.
