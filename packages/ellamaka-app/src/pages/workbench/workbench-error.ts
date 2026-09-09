import { showToast } from "@wopal/ui/toast"

export const WORKBENCH_ERROR_EVENT = "ellamaka:workbench-error"

export type WorkbenchErrorDetail = {
  operation: string
  message: string
  statusCode?: number
}

function extractMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message
  return String(error)
}

function extractStatusCode(error: unknown): number | undefined {
  if (error && typeof error === "object" && "statusCode" in error && typeof error.statusCode === "number") return error.statusCode
  return undefined
}

export function reportWorkbenchError(
  operation: string,
  error: unknown,
  options?: { silent?: boolean },
): void {
  const message = extractMessage(error)
  const statusCode = extractStatusCode(error)

  const logParts = [`[workbench] ${operation} failed:`, message]
  if (statusCode !== undefined) logParts.push(`(status: ${statusCode})`)
  console.error(...logParts)

  if (options?.silent) return

  if (typeof window !== "undefined") {
    const handled = !window.dispatchEvent(
      new CustomEvent<WorkbenchErrorDetail>(WORKBENCH_ERROR_EVENT, {
        cancelable: true,
        detail: { operation, message, statusCode },
      }),
    )
    if (handled) return
  }

  showToast({
    variant: "error",
    title: operation,
    description: message,
  })
}
