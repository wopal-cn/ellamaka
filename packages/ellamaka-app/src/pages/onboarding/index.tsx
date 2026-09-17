import { OnboardingClientProvider } from "./onboarding-client-context"
import { OnboardingRoot } from "./onboarding-root"

export default function OnboardingPage() {
  return (
    <OnboardingClientProvider>
      <OnboardingRoot />
    </OnboardingClientProvider>
  )
}
