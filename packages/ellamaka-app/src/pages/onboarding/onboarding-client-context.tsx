import { createSimpleContext } from "@wopal/ui/context"
import { type ParentProps } from "solid-js"
import { useServerSDK } from "@/context/server-sdk"
import { createSetupClient, type SetupClient } from "./setup-client"

const context = createSimpleContext({
  name: "SetupClient",
  init: (): SetupClient => {
    const sdk = useServerSDK()
    return createSetupClient(sdk.client)
  },
})

// Thin named wrappers: destructuring `provider`/`use` off the factory result
// trips the unbound-method lint rule, and the wrappers keep the public API
// identical for consumers.
export function OnboardingClientProvider(props: ParentProps) {
  return <context.provider>{props.children}</context.provider>
}

export function useOnboardingClient() {
  return context.use()
}
