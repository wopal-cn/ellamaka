import { createEffect, createResource, createSignal, Show } from "solid-js"
import type { WorkbenchPanel } from "../view-store"
import { useWorkbenchActions } from "../workbench-actions"
import { useWorkbenchState } from "../view-store"
import { scopeFromTab, GENERAL_SCOPE_NAME } from "../workbench-scope"
import { reportWorkbenchError } from "../workbench-error"
import { useServerSDK } from "@/context/server-sdk"
import { useWorkbenchRuntime } from "../workbench-runtime"

type Location = {
  key: string
  kind: "space-root" | "project" | "recent" | "search"
  name: string
  path: string
  relativeDirectory: string
}

export type LoaderLocation = Location

/**
 * Directory label for the location selector. The backend `name` field is a
 * display name (space title, project title); the selector shows directories,
 * so nested locations use their path relative to the space root and the
 * space root itself falls back to its directory basename.
 */
export function directoryLabel(location: Location): string {
  if (location.relativeDirectory) return location.relativeDirectory
  const basename = location.path.split("/").filter(Boolean).at(-1)
  return basename ?? location.path
}

export function PanelLoader(props: { panel: WorkbenchPanel; spaceName: string; spacePath: string }) {
  const actions = useWorkbenchActions()
  const wb = useWorkbenchState()
  const sdk = useServerSDK()
  const runtime = useWorkbenchRuntime()
  const [creating, setCreating] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const [selectedLocation, setSelectedLocation] = createSignal<Location>()
  const isGeneral = () => props.spacePath === ""
  const [locations] = createResource(
    () => (isGeneral() ? undefined : props.spacePath),
    async (spacePath): Promise<Location[]> => {
      if (!spacePath) return []
      const result = await sdk.bff.workbench.locations({ spacePath })
      return result.data?.items ?? []
    },
  )

  createEffect(() => {
    props.spacePath
    setError(undefined)
    setSelectedLocation(undefined)
  })

  createEffect(() => {
    const first = locations()?.[0]
    if (!first || selectedLocation()) return
    setSelectedLocation(first)
  })

  const handleStartSession = async (initialView: "chat" | "tui") => {
    if (creating()) return
    if (!runtime.canWrite()) {
      setError("服务暂不可用，恢复连接后再试")
      return
    }
    const location = selectedLocation()
    if (!isGeneral() && !location) {
      setError("请选择一个目录后再创建会话")
      return
    }
    setCreating(true)
    setError(undefined)
    try {
      if (location) wb.setPanelDirectory(props.spacePath, props.panel.id, location.path)
      const result = await actions.createSession({
        scope: scopeFromTab({ name: props.spaceName, path: props.spacePath }),
        panelID: props.panel.id,
        initialView,
        relativeDirectory: location?.relativeDirectory,
      })
      if (result.status === "offline") setError("服务暂不可用，恢复连接后再试")
    } catch (cause) {
      reportWorkbenchError("create session", cause)
      setError("创建会话失败，请重试")
    } finally {
      setCreating(false)
    }
  }

  return (
    <div class="flex flex-col items-center justify-center h-full gap-6 px-6 text-center bg-v2-background-bg-deep select-none">
      <div class="flex flex-col gap-2 max-w-sm">
        <div class="text-16-bold text-v2-text-text-strong">未装载会话</div>
        <div class="text-12-regular text-v2-text-text-muted leading-relaxed">
          当前空间:{" "}
          <span class="text-v2-text-text-base [font-weight:530]">
            {props.spaceName === GENERAL_SCOPE_NAME ? "Sessions" : props.spaceName}
          </span>
          <br />
          <Show when={!isGeneral()} fallback="你可以创建独立 Chat 或 TUI 会话，也可以从左侧会话树恢复历史会话。">
            选择当前 Space 内的受控目录，然后创建 Chat 或 TUI 会话。
          </Show>
        </div>
      </div>

      <div class="flex flex-col gap-3 w-full max-w-xs items-stretch bg-v2-background-bg-base border border-v2-border-border-base p-4 rounded-lg shadow-sm">
        <Show when={!isGeneral()}>
          <label class="flex flex-col gap-1 text-left text-11-regular text-v2-text-text-muted">
            目录
            <select
              class="w-full rounded-md border border-v2-border-border-base bg-v2-background-bg-deep px-2 py-1.5 text-12-regular text-v2-text-text-base"
              disabled={locations.loading || locations.error !== undefined || creating()}
              value={selectedLocation()?.key ?? ""}
              onChange={(event) =>
                setSelectedLocation(locations()?.find((item) => item.key === event.currentTarget.value))
              }
            >
              <option value="">{locations.loading ? "正在加载目录..." : "选择目录"}</option>
              <ForLocations locations={locations} />
            </select>
          </label>
          <Show when={locations.error}>
            <div class="text-left text-11-regular text-amber-600">目录列表暂不可用，已保留当前面板状态。</div>
          </Show>
        </Show>
        <button
          type="button"
          class="w-full py-2 rounded-md bg-v2-icon-icon-brand text-white text-12-bold cursor-pointer transition-colors hover:opacity-90 active:opacity-95 disabled:opacity-40 disabled:cursor-not-allowed"
          disabled={creating() || !runtime.canWrite()}
          onClick={() => void handleStartSession("chat")}
        >
          <Show when={!creating()} fallback="创建中...">
            新建 Chat 会话
          </Show>
        </button>
        <button
          type="button"
          class="w-full py-2 rounded-md border border-v2-border-border-base text-v2-text-text-base text-12-bold cursor-pointer transition-colors hover:bg-v2-overlay-simple-overlay-hover disabled:opacity-40 disabled:cursor-not-allowed"
          disabled={creating() || !runtime.canWrite()}
          onClick={() => void handleStartSession("tui")}
        >
          新建 TUI 会话
        </button>
        <Show when={error()}>
          <div class="text-11-regular text-red-500">{error()}</div>
        </Show>
      </div>
    </div>
  )
}

function ForLocations(props: { locations: () => Location[] | undefined }) {
  return (
    <>
      {(props.locations() ?? []).map((location) => (
        <option value={location.key}>{directoryLabel(location)}</option>
      ))}
    </>
  )
}
