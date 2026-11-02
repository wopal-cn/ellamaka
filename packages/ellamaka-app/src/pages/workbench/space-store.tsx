import { createSimpleContext } from "@wopal/ui/context"
import { createEffect, createMemo, createResource, createSignal, onCleanup } from "solid-js"
import { useServerSDK } from "@/context/server-sdk"
import { useWorkbenchState } from "./view-store"
import { reportWorkbenchError } from "./workbench-error"
import { useWorkbenchRuntime } from "./workbench-runtime"
import { normalizeSpacePath } from "./workbench-scope"
import { scopeFromTab } from "./workbench-scope"
import { useWorkbenchActions } from "./workbench-actions"

export type WopalSpace = {
  id: string
  name: string
  path: string
  type?: string
}

export function isSpaceNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  return (
    ("_tag" in error && error._tag === "WorkbenchSpaceNotFound") ||
    ("status" in error && error.status === 404) ||
    ("statusCode" in error && error.statusCode === 404)
  )
}

export async function fetchSpaces(sdk: {
  bff?: { workbench: { locations: (input: { spacePath: string }) => Promise<{ data?: { scopePath: string } }> } }
  client: {
    wopalSpace: {
      space: {
        list: () => Promise<{
          data?: { items?: Array<{ name: string; displayName: string; path: string; type?: string }> } | null
        }>
      }
    }
  }
}): Promise<WopalSpace[]> {
  // Registered Spaces are a Public Platform WopalSpace fact; reading them no
  // longer depends on a Wopal CLI health gate.
  const res = await sdk.client.wopalSpace.space.list()
  const raw = res.data?.items ?? []
  return Promise.all(
    raw.map(async (s) => ({
      id: s.name,
      name: s.displayName.replace(/[\s+*]+$/, "").trim() || s.displayName,
      path: normalizeSpacePath(
        (await sdk.bff?.workbench.locations({ spacePath: s.path }).catch(() => undefined))?.data?.scopePath ?? s.path,
      ),
      ...(s.type === undefined ? {} : { type: s.type }),
    })),
  )
}

const SpaceStoreContext = createSimpleContext({
  name: "SpaceStore",
  init: () => {
    const sdk = useServerSDK()
    const wb = useWorkbenchState()
    const runtime = useWorkbenchRuntime()
    const actions = useWorkbenchActions()

    const [lastSuccessful, setLastSuccessful] = createSignal<WopalSpace[]>([])
    const [lastError, setLastError] = createSignal<unknown>()
    const [reconciling, setReconciling] = createSignal(false)
    const [spacesResource, spacesActions] = createResource(
      () => runtime.canReadSpaces(),
      (available) => (available ? fetchSpaces(sdk) : Promise.resolve(lastSuccessful())),
    )

    createEffect(() => {
      // Read the settled value, never the throwing one: a rejected resource
      // re-throws when read in a tracking scope, which would carry a transient
      // 401 (stale credentials mid-switch) into the shell error boundary and
      // crash the whole workbench. The UI already surfaces the failure through
      // the unauthorized overlay; the list simply holds its last good value.
      if (spacesResource.error) return
      const settled = spacesResource.latest
      if (settled) {
        setLastSuccessful(settled)
        setLastError(undefined)
      }
    })

    createEffect(() => {
      const error = spacesResource.error
      if (!error) return
      reportWorkbenchError("fetch spaces", error)
      setLastError(error)
    })

    const spaces = createMemo(() => {
      // `latest` is undefined until the first success; the signal then carries
      // every later failure without touching the throwing read path.
      return lastSuccessful()
    })

    // 在 spaces 列表加载完毕后，校验 wb 中的 tabs 列表
    createEffect(() => {
      const list = spaces()
      if (list.length === 0 || !wb.ready()) return
      const validPaths = new Set(list.map((s) => s.path))
      const aliases = wb.tabs.filter((tab) => tab.path && !validPaths.has(tab.path)).map((tab) => tab.path)
      let cancelled = false
      setReconciling(true)
      onCleanup(() => {
        cancelled = true
        setReconciling(false)
      })
      void Promise.all(
        aliases.map(async (path) => {
          try {
            const result = await sdk.bff.workbench.locations({ spacePath: path })
            return { path, root: result.data?.scopePath }
          } catch (error) {
            return { path, root: undefined, missing: isSpaceNotFound(error) }
          }
        }),
      ).then(async (resolved) => {
        if (cancelled) return
        for (const item of resolved) {
          if (!item.root || !validPaths.has(item.root)) continue
          const tab = wb.tabs.find((entry) => entry.path === item.path)
          const from = tab ? scopeFromTab(tab) : undefined
          const to = { kind: "space" as const, name: tab?.name ?? item.root, path: item.root }
          if (from && !(await actions.reconcileSpaceIdentity(from, to))) validPaths.add(item.path)
        }
        // Keep unresolved tabs until their identity can be verified.
        for (const item of resolved) if (!item.root && !item.missing) validPaths.add(item.path)
        wb.validateTabs(validPaths)
        setReconciling(false)
      })
    })

    return {
      spaces,
      get reconciling() {
        return reconciling()
      },
      get spacesLoading() {
        return spacesResource.loading
      },
      get error() {
        return lastError()
      },
      reload: () => (runtime.canReadSpaces() ? spacesActions.refetch() : Promise.resolve(lastSuccessful())),
    }
  },
})

export const useSpaceStore = () => SpaceStoreContext.use()
export const SpaceStoreProvider = SpaceStoreContext.provider
