import { For, Show } from "solid-js"
import type { PermissionRequest } from "@opencode-ai/sdk/v2"
import { Button } from "@wopal/ui/button"
import { DockPrompt } from "@wopal/ui/dock-prompt"
import { Icon } from "@wopal/ui/icon"
import { useLanguage } from "@/context/language"
import { publishEscalatedSandboxPreset, type SandboxPreset } from "@/components/prompt-input/sandbox-control"

const ESCALATION_REASON_PREFIX = /^escalate sandbox to [a-z-]+:\s*/

function metadataString(metadata: PermissionRequest["metadata"], key: string): string {
  const value = metadata[key]
  return typeof value === "string" ? value : ""
}

// The escalation target mode doubles as the composer preset value, except the
// one-shot dsh vocabulary `danger-full-access` which the composer spells
// `full-access` (the composer never persists a one-shot mode; the preset is
// the standing "sandbox off" selection).
function escalationPreset(targetMode: string): SandboxPreset | undefined {
  if (targetMode === "read-only" || targetMode === "workspace-write") return targetMode
  if (targetMode === "danger-full-access") return "full-access"
  return undefined
}

export function SessionPermissionDock(props: {
  request: PermissionRequest
  responding: boolean
  onDecide: (response: "once" | "always" | "reject") => void
}) {
  const language = useLanguage()

  const toolDescription = () => {
    const key = `settings.permissions.tool.${props.request.permission}.description`
    const value = language.t(key as Parameters<typeof language.t>[0])
    if (value === key) return ""
    return value
  }

  const justification = () => {
    const reason = metadataString(props.request.metadata, "justification")
    return reason.replace(ESCALATION_REASON_PREFIX, "")
  }

  const detail = () => {
    const filepath = metadataString(props.request.metadata, "filepath")
    if (filepath) return filepath
    return ""
  }

  const decide = (response: "once" | "always" | "reject") => {
    if (response === "always" && props.request.permission === "sandbox_escalation") {
      const preset = escalationPreset(metadataString(props.request.metadata, "targetMode"))
      if (preset) publishEscalatedSandboxPreset(preset)
    }
    props.onDecide(response)
  }

  return (
    <DockPrompt
      kind="permission"
      header={
        <div data-slot="permission-row" data-variant="header">
          <span data-slot="permission-icon">
            <Icon name="warning" size="normal" />
          </span>
          <div data-slot="permission-header-title">{language.t("notification.permission.title")}</div>
        </div>
      }
      footer={
        <>
          <div />
          <div data-slot="permission-footer-actions">
            <Button variant="ghost" size="normal" onClick={() => decide("reject")} disabled={props.responding}>
              {language.t("ui.permission.deny")}
            </Button>
            <Button
              variant="secondary"
              size="normal"
              onClick={() => decide("always")}
              disabled={props.responding}
            >
              {language.t("ui.permission.allowAlways")}
            </Button>
            <Button variant="primary" size="normal" onClick={() => decide("once")} disabled={props.responding}>
              {language.t("ui.permission.allowOnce")}
            </Button>
          </div>
        </>
      }
    >
      <Show when={toolDescription()}>
        <div data-slot="permission-row">
          <span data-slot="permission-spacer" aria-hidden="true" />
          <div data-slot="permission-hint">{toolDescription()}</div>
        </div>
      </Show>

      <Show when={detail()}>
        <div data-slot="permission-row">
          <span data-slot="permission-spacer" aria-hidden="true" />
          <div data-slot="permission-hint">{detail()}</div>
        </div>
      </Show>

      <Show when={justification()}>
        <div data-slot="permission-row">
          <span data-slot="permission-spacer" aria-hidden="true" />
          <div data-slot="permission-hint">{justification()}</div>
        </div>
      </Show>

      <Show when={props.request.patterns.length > 0}>
        <div data-slot="permission-row">
          <span data-slot="permission-spacer" aria-hidden="true" />
          <div data-slot="permission-patterns">
            <For each={props.request.patterns}>
              {(pattern) => <code class="text-12-regular text-text-base break-all">{pattern}</code>}
            </For>
          </div>
        </div>
      </Show>
    </DockPrompt>
  )
}
