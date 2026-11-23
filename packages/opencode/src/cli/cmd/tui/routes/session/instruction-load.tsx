/** @jsxImportSource @opentui/solid */
import { createMemo, For, Show } from "solid-js"
import type { RGBA } from "@opentui/core"
import type { Part, ToolPart } from "@wopal/ellamaka-sdk/v2"
import { instructionSourcePaths as parseInstructionSourcePaths } from "@wopal/ellamaka-core/util/instruction-sources"
import { useTheme } from "@tui/context/theme"
import { usePathFormatter } from "../../context/path-format"

export function instructionSourcePaths(part: Part): string[] | undefined {
  return parseInstructionSourcePaths(part)
}

export function userInstructionSourcePaths(parts: readonly Part[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const part of parts) {
    const paths = instructionSourcePaths(part)
    if (!paths) continue
    for (const item of paths) {
      if (seen.has(item)) continue
      seen.add(item)
      result.push(item)
    }
  }
  return result
}

export function toolLoadedRules(part: ToolPart): { loaded: string[]; suspended: boolean } {
  if (part.state.status !== "completed" || part.state.time.compacted) {
    return { loaded: [], suspended: false }
  }
  const value: unknown = part.state.metadata?.loaded
  const loaded = Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === "string"))]
    : []
  return {
    loaded,
    suspended: part.state.title === "Instructions required",
  }
}

export function LoadedInstructionRows(props: {
  paths: readonly string[]
  format: (input?: string) => string
  suspended?: boolean
  mutedColor?: RGBA | string
  warningColor?: RGBA | string
  marginTop?: number
}) {
  return (
    <Show when={props.paths.length > 0 || props.suspended}>
      <box flexDirection="column" marginTop={props.marginTop ?? 0} flexShrink={0}>
        <For each={props.paths}>
          {(filepath) => (
            <box paddingLeft={3} flexShrink={0}>
              <text paddingLeft={3} fg={props.mutedColor}>
                ↳ Loaded {props.format(filepath)}
              </text>
            </box>
          )}
        </For>
        <Show when={props.suspended}>
          <box paddingLeft={3} flexShrink={0}>
            <text paddingLeft={3} fg={props.warningColor}>
              File not modified; retry required
            </text>
          </box>
        </Show>
      </box>
    </Show>
  )
}

export function UserInstructionSources(props: { parts: readonly Part[]; marginTop?: number }) {
  const { theme } = useTheme()
  const pathFormatter = usePathFormatter()
  const paths = createMemo(() => userInstructionSourcePaths(props.parts))
  return (
    <LoadedInstructionRows
      paths={paths()}
      format={pathFormatter.format}
      mutedColor={theme.textMuted}
      marginTop={props.marginTop}
    />
  )
}

export function ToolLoadedRules(props: { part: ToolPart }) {
  const { theme } = useTheme()
  const pathFormatter = usePathFormatter()
  const info = createMemo(() => toolLoadedRules(props.part))
  return (
    <LoadedInstructionRows
      paths={info().loaded}
      format={pathFormatter.format}
      suspended={info().suspended}
      mutedColor={theme.textMuted}
      warningColor={theme.warning}
    />
  )
}
