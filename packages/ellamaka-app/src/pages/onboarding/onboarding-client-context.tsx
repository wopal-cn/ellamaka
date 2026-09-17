import { createSimpleContext } from "@wopal/ui/context"
import { type ParentProps } from "solid-js"
import { createOnboardingClient, credentialsFromConnection, type OnboardingClient } from "@/lib/onboarding-client"
import { useServer } from "@/context/server"

const context = createSimpleContext({
  name: "OnboardingClient",
  init: (): OnboardingClient => {
    const server = useServer()
    const connection = () => server.current
    const credentials = () => {
      const c = connection()
      if (!c) return null
      return credentialsFromConnection(c.http)
    }
    return createOnboardingClient({ credentials: credentials() })
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
