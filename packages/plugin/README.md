# @wopal/ellamaka-plugin

Type declarations and compatibility metadata for Ellamaka server and TUI plugins.

```ts
import type { Plugin, PluginInput } from "@wopal/ellamaka-plugin"

export const MyPlugin: Plugin = async (input: PluginInput) => {
  await input.client.session.get({ path: { id: "ses_example" } })
  return {}
}
```

`PluginInput.client` retains the nested plugin request shape (`path`, `query`, `body`, and request options) used by existing plugins. The Ellamaka engine maps each operation to the canonical generated SDK request; plugin code continues to use the existing client type and call style. Consult the running Server's complete API document at `GET /doc` for every available operation and its audience. The public service contract is published separately with `@wopal/ellamaka-sdk`.

The public compatibility table is available at `@wopal/ellamaka-plugin/client-compat`.
