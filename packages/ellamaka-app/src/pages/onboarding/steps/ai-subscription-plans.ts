export interface AiSubscriptionPlan {
  id: string
  providerId: string
  name: string
  description: string
  introductoryPriceUsd: number
  monthlyPriceUsd: number
  cancellable: boolean
  signupUrl: string
}

export const AI_SUBSCRIPTION_PLANS: readonly AiSubscriptionPlan[] = [
  {
    id: "opencode-go",
    providerId: "opencode-go",
    name: "OpenCode Go",
    description: "可选择中国当前前沿大模型",
    introductoryPriceUsd: 5,
    monthlyPriceUsd: 10,
    cancellable: true,
    signupUrl: "https://opencode.ai/go?ref=SHWS6GTKT2",
  },
]
