import { Show, createMemo, createResource, type Accessor, type JSX } from "solid-js"
import type { PluginSpec } from "./sandbox-control"
import type { useCheckServerHealth } from "@/utils/server-health"
import { pathKey } from "@/utils/path-key"
import { Icon } from "@wopal/ui/icon"
import { Select } from "@wopal/ui/select"
import {
  SANDBOX_PRESETS,
  readSandboxOptions,
  sandboxControlConfig,
  sandboxToPreset,
  shouldShowSandboxControl,
  type SandboxPreset,
} from "./sandbox-control"

type SandboxEffective = {
  ellamaka?: { plugin?: PluginSpec[] }
  wopal?: { pluginConfig?: Record<string, Record<string, unknown>> }
}

type SandboxSdk = {
  directory: string
  createClient: (options: { directory: string }) => {
    config: { configGet: () => Promise<{ data?: { effective?: SandboxEffective } }> }
  }
}

export function PromptInputSandboxControl(props: {
  variant: string | undefined
  sdk: SandboxSdk
  serverHttp: Accessor<{ url: string; username?: string; password?: string } | undefined>
  checkServerHealth: ReturnType<typeof useCheckServerHealth>
  preset?: Accessor<SandboxPreset | undefined>
  onSelect: (preset: SandboxPreset) => void
  t: (key: string) => string
  style?: JSX.CSSProperties
}) {
  const [sandboxHealth] = createResource(props.serverHttp, (http) =>
    http ? props.checkServerHealth(http).catch(() => undefined) : undefined,
  )
  const [sandboxConfig] = createResource(
    () => pathKey(props.sdk.directory),
    (directory) =>
      props.sdk
        .createClient({ directory })
        .config.configGet()
        .then((r) => r.data?.effective ?? undefined)
        .catch(() => undefined),
  )
  const sandboxInputs = createMemo(() => sandboxControlConfig(sandboxConfig()))
  const visible = createMemo(() =>
    shouldShowSandboxControl({
      variant: props.variant,
      dshStatus: sandboxHealth()?.dsh,
      ...sandboxInputs(),
    }),
  )
  const defaultPreset = createMemo(() => sandboxToPreset(readSandboxOptions(sandboxInputs().sandbox)))
  const preset = createMemo(() => props.preset?.() ?? defaultPreset())

  return (
    <Show when={visible()}>
      <div class="relative" data-sandbox-preset={preset()}>
        <div class="pointer-events-none absolute left-2 top-1/2 z-10 flex size-4 -translate-y-1/2 items-center justify-center text-v2-icon-icon-muted">
          <Icon name="shield" size="small" />
        </div>
        <Select
          size="normal"
          options={SANDBOX_PRESETS}
          current={preset()}
          value={(x) => x}
          label={(x) => props.t(`prompt.sandbox.${x}`)}
          onSelect={(value) => {
            if (!value || value === preset()) return
            props.onSelect(value)
          }}
          disabled={false}
          class="max-w-[150px] justify-start text-v2-text-text-faint [&_[data-component=icon]]:text-v2-icon-icon-muted"
          valueClass="truncate pl-5 text-[13px] font-[440] leading-5 text-v2-text-text-faint"
          triggerStyle={props.style}
          triggerProps={{ "data-action": "prompt-sandbox" }}
          variant="ghost"
        />
      </div>
    </Show>
  )
}
