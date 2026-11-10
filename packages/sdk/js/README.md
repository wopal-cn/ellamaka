# @wopal/ellamaka-sdk

The public Platform SDK for an Ellamaka Server.

## Install

```bash
npm install @wopal/ellamaka-sdk@2.1.1
```

| Entrypoint                                      | Use it when                                                                                                                                         |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@wopal/ellamaka-sdk`                           | Default. Same client as `/http`, plus host helpers (`createEllamakaServer`, `createEllamakaTui`, `createEllamaka`). Importing it starts no process. |
| `@wopal/ellamaka-sdk/http`                      | Only the generated client for Runtime and WopalSpace calls.                                                                                         |
| `@wopal/ellamaka-sdk/local`                     | Ontology and Space **without** an HTTP Server (runs a bundled Worker).                                                                              |
| `@wopal/ellamaka-sdk/openapi` / `/openapi.json` | The shipped public contract, for discovery and codegen.                                                                                             |
| `@wopal/ellamaka-sdk/v2/gen/types`              | Generated request/response types, when you need to name a DTO.                                                                                      |
| `/client`, `/server`, `/v2/*`                   | Kept for existing consumers. Same client, older entry names.                                                                                        |

## Quick start

```ts
import { createEllamakaClient } from "@wopal/ellamaka-sdk"

const client = createEllamakaClient({ baseUrl: "http://127.0.0.1:4096" })

const health = await client.global.health()
const sessions = await client.session.list()
```

## Authentication

A Server started with a password requires HTTP Basic authentication on every route. The username defaults to `ellamaka` (`ELLAMAKA_SERVER_USERNAME`) and the password is `ELLAMAKA_SERVER_PASSWORD`, or whatever `ellamaka serve --username/--password` was given.

Pass the header explicitly — the generated client does not attach credentials by itself:

```ts
const client = createEllamakaClient({
  baseUrl: "http://127.0.0.1:4096",
  headers: {
    Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
  },
})
```

`createEllamakaLocalClient` needs no authentication: it never opens a socket.

## Errors

Calls return `{ data, error, response }` and never throw unless asked to:

```ts
const result = await client.wopalSpace.space.status({ name })
if (result.error) {
  // WopalSpace errors carry code + message (+ optional suggestion).
  console.log(result.response?.status, result.error.code, result.error.message)
}
```

With `{ throwOnError: true }` the client throws an `Error` whose `message` is the server message and whose `cause` holds `{ body, status }`. Validation errors use a different shape (`_tag: "InvalidRequestError"`, `message`, optional `field`), so narrow before reading `code`.

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

The root entrypoint follows the canonical flat v2 call shape. Code that used the old root nested `path`/`body` arguments must move to `/v2` or `/http` and update calls such as:

```ts
// Before: root v1-shaped call
await client.session.get({ path: { id: sessionID } })

// Canonical
await client.session.get({ sessionID })
```

`@wopal/ellamaka-sdk/client`, `/server`, and `/v2/*` remain available for existing consumers. The compatibility adapter for `PluginInput.client` remains in `@wopal/ellamaka-plugin` and keeps the old nested shape for plugin authors.

## Trusted-local Worker

Use `@wopal/ellamaka-sdk/local` for Ontology and Space operations that must run on the same machine without starting an HTTP Server:

```ts
import { createEllamakaLocalClient } from "@wopal/ellamaka-sdk/local"

const local = await createEllamakaLocalClient({
  wopalHome: "/path/to/.wopal",
  directory: "/path/to/space",
})

const spaces = await local.client.wopalSpace.space.list()
await local.dispose()
```

The client launches the published, self-contained Worker asset under `dist/local/worker.js`; it does not start the Ellamaka Runtime or DSH. `client.wopalSpace.ontology` and `client.wopalSpace.space` are the only exposed operation groups. Setup and Runtime routes return `LOCAL_OPERATION_UNSUPPORTED` before business handlers run. `dispose()` waits for accepted requests to finish and then shuts down the Worker. Relocators such as a Node SEA launcher can pass the published Worker asset location with `workerPath`.

## Examples

Runnable examples ship in `examples/` as TypeScript sources. Each one is also compiled into `dist/examples/` so plain Node runs it without a TypeScript loader.

| Example       | Needs a Server | Shows                                              |
| ------------- | -------------- | -------------------------------------------------- |
| `discover`    | no             | Listing every capability from the shipped contract |
| `local-space` | no             | Ontology/Space in-process, with `dispose()`        |
| `http-basic`  | yes            | Authenticated health and Space listing             |
| `errors`      | yes            | Reading `error` vs catching with `throwOnError`    |

```bash
node node_modules/@wopal/ellamaka-sdk/dist/examples/discover.js
ELLAMAKA_PASSWORD=... node node_modules/@wopal/ellamaka-sdk/dist/examples/http-basic.js
```

Read the annotated `examples/*.ts` sources; run the compiled `dist/examples/*.js`.
