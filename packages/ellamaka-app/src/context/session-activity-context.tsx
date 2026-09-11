import { createSimpleContext } from "@wopal/ui/context"
import { onCleanup, onMount } from "solid-js"
import { useServerSDK } from "./server-sdk"
import { createSessionActivity } from "./session-activity"

export const { use: useSessionActivity, provider: SessionActivityProvider } = createSimpleContext({
  name: "SessionActivity",
  init: () => {
    const sdk = useServerSDK()
    const activity = createSessionActivity({
      snapshot: async () => (await sdk.client.workbench.sessionStatuses({ throwOnError: true })).data ?? [],
      onError: (error) => console.warn("Failed to refresh session activity", error),
    })
    onCleanup(
      sdk.event.listen(({ name, details }) => {
        activity.receive(name, details)
        // Initial stream connection closes the snapshot/subscription race. This
        // lightweight reconciliation does not refresh Panels or directory stores.
        if (details.type === "server.connected" || details.type === "global.disposed") void activity.refresh()
      }),
    )
    onMount(() => void activity.refresh())
    onCleanup(() => activity.dispose())
    return activity
  },
})
