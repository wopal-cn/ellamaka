import type { TuiPlugin, TuiPluginApi, TuiPluginStatus } from "@wopal/ellamaka-plugin/tui"
import type { InternalTuiPlugin } from "../../plugin/internal"
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { serverPlugins, tuiPlugins } from "./plugin-status"

const id = "internal:sidebar-plugins"
type DshStatus = "disabled" | "preparing" | "ready" | "degraded"

export function View(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const [dsh, setDsh] = createSignal<DshStatus>()
  const [sandbox, setSandbox] = createSignal<unknown>()
  const [home, setHome] = createSignal<string>()
  const [spaceRoot, setSpaceRoot] = createSignal<string>()
  const [tui, setTui] = createSignal<ReadonlyArray<TuiPluginStatus>>([])
  const [serverOpen, setServerOpen] = createSignal(true)
  const [tuiOpen, setTuiOpen] = createSignal(true)
  const server = createMemo(() =>
    serverPlugins(props.api.state.config.plugin, sandbox(), dsh(), {
      spaceRoot: spaceRoot() ?? props.api.state.path.worktree,
      home: home(),
    }),
  )
  const local = createMemo(() => tuiPlugins(tui()))
  let disposed = false
  let busy = false
  const controller = new AbortController()

  const refresh = async () => {
    if (busy) return
    busy = true
    setTui(props.api.plugins.list())
    try {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(4000)])
      const [health, config, paths, space] = await Promise.allSettled([
        props.api.client.global.health({ throwOnError: true, signal }),
        props.api.client.config.configGet(
          { directory: props.api.state.path.directory },
          { throwOnError: true, signal },
        ),
        props.api.client.path.get({ directory: props.api.state.path.directory }, { throwOnError: true, signal }),
        props.api.client.wopalSpace.space.resolve(
          { directory: props.api.state.path.directory },
          { throwOnError: true, signal },
        ),
      ])
      if (disposed) return
      setDsh(health.status === "fulfilled" ? health.value.data?.dsh?.tools : undefined)
      const effective = config.status === "fulfilled" ? config.value.data?.effective : undefined
      setSandbox(effective ? (effective.wopal.pluginConfig["dsh-adapter"]?.sandbox ?? { enabled: false }) : undefined)
      setHome(paths.status === "fulfilled" ? paths.value.data?.home : undefined)
      setSpaceRoot(space.status === "fulfilled" ? space.value.data?.path : undefined)
      setTui(props.api.plugins.list())
    } finally {
      busy = false
    }
  }

  onMount(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), 5000)
    onCleanup(() => {
      disposed = true
      controller.abort()
      clearInterval(timer)
    })
  })

  const text = (status: string) =>
    ({
      enabled: "Enabled",
      disabled: "Disabled",
      preparing: "Preparing",
      unavailable: "Unavailable",
      unknown: "Unknown",
      configured: "Configured",
      active: "Active",
      inactive: "Inactive",
    })[status] ?? status
  const color = (status: string) =>
    status === "enabled" || status === "active"
      ? theme().success
      : status === "unavailable" || status === "inactive"
        ? theme().error
        : status === "preparing"
          ? theme().warning
          : theme().textMuted

  return (
    <box gap={1}>
      <box>
        <box flexDirection="row" gap={1} onMouseDown={() => setServerOpen((value) => !value)}>
          <text fg={theme().text}>
            {serverOpen() ? "▼" : "▶"} <b>Server Plugins</b>
          </text>
        </box>
        <Show when={serverOpen()}>
          <For each={server()}>
            {(item) => (
              <text fg={theme().text} wrapMode="word">
                <span style={{ fg: color(item.status) }}>•</span> {item.name}{" "}
                <span style={{ fg: theme().textMuted }}>
                  {item.source} · {text(item.status)}
                </span>
              </text>
            )}
          </For>
        </Show>
      </box>
      <box>
        <box flexDirection="row" gap={1} onMouseDown={() => setTuiOpen((value) => !value)}>
          <text fg={theme().text}>
            {tuiOpen() ? "▼" : "▶"} <b>TUI Plugins</b>{" "}
            <span style={{ fg: theme().textMuted }}>({local().length})</span>
          </text>
        </box>
        <Show when={tuiOpen()}>
          <For each={local()}>
            {(item) => (
              <text fg={theme().text} wrapMode="word">
                <span style={{ fg: color(item.status) }}>•</span> {item.name}{" "}
                <span style={{ fg: theme().textMuted }}>{text(item.status)}</span>
              </text>
            )}
          </For>
        </Show>
      </box>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 400,
    slots: {
      sidebar_content() {
        return <View api={api} />
      },
    },
  })
}

const plugin: InternalTuiPlugin = { id, tui }
export default plugin
