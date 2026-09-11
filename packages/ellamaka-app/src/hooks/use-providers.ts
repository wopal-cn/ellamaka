import { useServerSync } from "@/context/server-sync"
import { useSDKDirectory, useSDKRuntime } from "@/context/sdk"
import { decode64 } from "@/utils/base64"
import { useParams } from "@solidjs/router"
import { Iterable, pipe } from "effect"
import { type Accessor, createContext, createMemo, useContext } from "solid-js"

export const popularProviders = [
  "opencode",
  "opencode-go",
  "anthropic",
  "github-copilot",
  "openai",
  "google",
  "openrouter",
  "vercel",
]
const popularProviderSet = new Set(popularProviders)

/**
 * A generic active-directory fallback for UI that is not itself inside a
 * directory SDK provider, such as Workbench settings. SDK scope still wins.
 */
export const ProviderDirectoryContext = createContext<Accessor<string | undefined>>()

export function resolveProviderDirectory(input: {
  directory?: Accessor<string | undefined>
  sdkDirectory?: Accessor<string>
  fallbackDirectory?: Accessor<string | undefined>
  catalogDirectory?: Accessor<string | undefined>
  routeDirectory: Accessor<string>
}) {
  return (
    input.directory?.() ??
    input.sdkDirectory?.() ??
    input.fallbackDirectory?.() ??
    input.catalogDirectory?.() ??
    input.routeDirectory()
  )
}

export function shouldBootstrapProviderDirectory(input: { directory: string; sdkRuntime?: boolean }) {
  return input.sdkRuntime !== false
}

export function useProviders(
  input: { directory?: Accessor<string | undefined>; fallbackDirectory?: Accessor<string | undefined> } = {},
) {
  const serverSync = useServerSync()
  const sdkDirectory = useSDKDirectory()
  const sdkRuntime = useSDKRuntime()
  const catalogDirectory = useContext(ProviderDirectoryContext)
  const params = useParams()
  const routeDirectory = createMemo(() => decode64(params.dir) ?? "")
  const dir = () =>
    resolveProviderDirectory({
      directory: input.directory,
      sdkDirectory,
      fallbackDirectory: input.fallbackDirectory,
      catalogDirectory,
      routeDirectory,
    })
  const providers = () => {
    const directory = dir()
    if (directory) {
      const [projectStore] = serverSync.child(directory, {
        bootstrap: shouldBootstrapProviderDirectory({ directory, sdkRuntime: sdkRuntime?.() }),
      })
      if (projectStore.provider_ready) return projectStore.provider
    }
    return serverSync.data.provider
  }
  return {
    all: () => providers().all,
    default: () => providers().default,
    popular: () =>
      pipe(
        providers().all,
        Iterable.map(([, p]) => p),
        Iterable.filter((p) => popularProviderSet.has(p.id)),
        (v) => Array.from(v),
      ),
    connected: () => {
      const connected = new Set(providers().connected)
      return pipe(
        providers().all,
        Iterable.map(([, p]) => p),
        Iterable.filter((p) => connected.has(p.id)),
        (v) => Array.from(v),
      )
    },
    paid: () => {
      const connected = new Set(providers().connected)
      return [
        ...Iterable.filter(
          providers().all,
          ([id]) =>
            connected.has(id) &&
            (id !== "opencode" || Object.values(providers().all.get(id)?.models ?? {}).some((m) => m.cost?.input)),
        ),
      ]
    },
  }
}
