export type ContextMetricsSnapshot = {
  total: number
  limit: number | undefined
  usage: number | null
}

export type ContextTone = "normal" | "warning" | "critical"

export function contextPercentage(context: ContextMetricsSnapshot | undefined): number | undefined {
  if (!context || context.usage === null) return undefined
  return context.usage
}

export function contextTone(percentage: number | undefined): ContextTone {
  if (percentage === undefined) return "normal"
  if (percentage >= 100) return "critical"
  if (percentage >= 80) return "warning"
  return "normal"
}

export function formatContextTooltip(context: ContextMetricsSnapshot, formatNumber: (value: number) => string): string {
  const tokens = formatNumber(context.total)
  if (context.usage === null) return `${tokens} tokens`
  return `${tokens} tokens (${context.usage}% of context)`
}
