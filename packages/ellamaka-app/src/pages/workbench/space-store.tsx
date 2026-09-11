import { createSimpleContext } from "@wopal/ui/context"
import { createEffect, createMemo, createResource, createSignal } from "solid-js"
import { useServerSDK } from "@/context/server-sdk"
import { useWorkbenchState } from "./view-store"
import { reportWorkbenchError } from "./workbench-error"
import { useWorkbenchRuntime } from "./workbench-runtime"
import { canUseSpaceControl } from "./cli-health"
import { normalizeSpacePath } from "./workbench-scope"

export type WopalSpace = {
  id: string
  name: string
  path: string
  type?: string
}

export async function fetchSpaces(
  sdk: { client: { wopalSpace: { spaces: () => Promise<{ data?: { spaces?: WopalSpace[] } | null }> } } },
): Promise<WopalSpace[]> {
  const res = await sdk.client.wopalSpace.spaces()
  const raw = res.data?.spaces ?? []
  return raw.map((s) => ({
    ...s,
    name: s.name.replace(/[\s+*]+$/, "").trim() || s.name,
    path: normalizeSpacePath(s.path),
  }))
}

const SpaceStoreContext = createSimpleContext({
  name: "SpaceStore",
  init: () => {
    const sdk = useServerSDK()
    const wb = useWorkbenchState()
    const runtime = useWorkbenchRuntime()

    const [lastSuccessful, setLastSuccessful] = createSignal<WopalSpace[]>([])
    const [lastError, setLastError] = createSignal<unknown>()
    const [spacesResource, spacesActions] = createResource(
      () => canUseSpaceControl(runtime.cli),
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
      if (list.length === 0) return
      const validPaths = new Set(list.map((s) => s.path))
      wb.validateTabs(validPaths)
    })

    return {
      spaces,
      get spacesLoading() { return spacesResource.loading },
      get error() { return lastError() },
      reload: () => canUseSpaceControl(runtime.cli) ? spacesActions.refetch() : Promise.resolve(lastSuccessful()),
    }
  },
})

export const useSpaceStore = () => SpaceStoreContext.use()
export const SpaceStoreProvider = SpaceStoreContext.provider
