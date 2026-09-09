import { Component, For, Show, createMemo, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { makeEventListener } from "@solid-primitives/event-listener"
import { Button } from "@wopal/ui/button"
import { showToast } from "@wopal/ui/toast"
import { formatKeybind, parseKeybind, useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { useSettings } from "@/context/settings"
import { SettingsList } from "./settings-list"

const IS_MAC = typeof navigator === "object" && /(Mac|iPod|iPhone|iPad)/.test(navigator.platform)

/**
 * This is deliberately a small, stable Workbench surface rather than a view
 * over the entire command registry. The registry also contains route-specific,
 * legacy and internal actions which are not settings users should maintain.
 */
const WORKBENCH_KEYBINDS = [
  { id: "session.new", titleKey: "command.session.new", editable: true },
  { id: "workbench.jumpToFirst", titleKey: "session.messages.jumpToFirst", keybind: "home", editable: false },
  { id: "workbench.previousUserMessage", titleKey: "command.message.previous", keybind: "pageup", editable: false },
  { id: "workbench.nextUserMessage", titleKey: "command.message.next", keybind: "pagedown", editable: false },
  { id: "workbench.jumpToLatest", titleKey: "session.messages.jumpToLatest", keybind: "end", editable: false },
  { id: "file.attach", titleKey: "prompt.action.attachFile", editable: true },
  { id: "file.open", titleKey: "command.file.open", editable: true },
  { id: "sidebar.toggle", titleKey: "command.sidebar.toggle", editable: true },
  { id: "model.choose", titleKey: "command.model.choose", editable: true },
  { id: "settings.open", titleKey: "command.settings.open", editable: true },
] as const

type WorkbenchKeybind = (typeof WORKBENCH_KEYBINDS)[number]

function fixedKeybind(entry: WorkbenchKeybind) {
  return "keybind" in entry ? entry.keybind : undefined
}

function isModifier(key: string) {
  return key === "Shift" || key === "Control" || key === "Alt" || key === "Meta"
}

function normalizeKey(key: string) {
  if (key === ",") return "comma"
  if (key === "+") return "plus"
  if (key === " ") return "space"
  return key.toLowerCase()
}

function recordKeybind(event: KeyboardEvent) {
  if (isModifier(event.key)) return

  const parts: string[] = []

  const mod = IS_MAC ? event.metaKey : event.ctrlKey
  if (mod) parts.push("mod")

  if (IS_MAC && event.ctrlKey) parts.push("ctrl")
  if (!IS_MAC && event.metaKey) parts.push("meta")
  if (event.altKey) parts.push("alt")
  if (event.shiftKey) parts.push("shift")

  const key = normalizeKey(event.key)
  if (!key) return
  parts.push(key)

  return parts.join("+")
}

function signatures(config: string | undefined) {
  if (!config) return []
  const sigs: string[] = []

  for (const kb of parseKeybind(config)) {
    const parts: string[] = []
    if (kb.ctrl) parts.push("ctrl")
    if (kb.alt) parts.push("alt")
    if (kb.shift) parts.push("shift")
    if (kb.meta) parts.push("meta")
    if (kb.key) parts.push(kb.key)
    if (parts.length === 0) continue
    sigs.push(parts.join("+"))
  }

  return sigs
}

function useKeyCapture(input: {
  active: () => string | null
  stop: () => void
  set: (id: string, keybind: string) => void
  used: () => Map<string, { id: string; title: string }[]>
  language: ReturnType<typeof useLanguage>
}) {
  onMount(() => {
    const handle = (event: KeyboardEvent) => {
      const id = input.active()
      if (!id) return

      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()

      if (event.key === "Escape") {
        input.stop()
        return
      }

      const clear =
        (event.key === "Backspace" || event.key === "Delete") &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !event.shiftKey
      if (clear) {
        input.set(id, "none")
        input.stop()
        return
      }

      const next = recordKeybind(event)
      if (!next) return

      const conflicts = new Map<string, string>()
      for (const sig of signatures(next)) {
        for (const item of input.used().get(sig) ?? []) {
          if (item.id === id) continue
          conflicts.set(item.id, item.title)
        }
      }

      if (conflicts.size > 0) {
        showToast({
          title: input.language.t("settings.shortcuts.conflict.title"),
          description: input.language.t("settings.shortcuts.conflict.description", {
            keybind: formatKeybind(next, input.language.t),
            titles: [...conflicts.values()].join(", "),
          }),
        })
        return
      }

      input.set(id, next)
      input.stop()
    }

    makeEventListener(document, "keydown", handle, { capture: true })
  })
}

export const SettingsKeybinds: Component = () => {
  const command = useCommand()
  const language = useLanguage()
  const settings = useSettings()

  const [store, setStore] = createStore({
    active: null as string | null,
  })

  const stop = () => {
    if (!store.active) return
    setStore("active", null)
    command.keybinds(true)
  }

  const start = (id: string) => {
    if (store.active === id) {
      stop()
      return
    }

    if (store.active) stop()

    setStore("active", id)
    command.keybinds(false)
  }

  const entries = createMemo(() => {
    language.locale()
    return WORKBENCH_KEYBINDS
  })

  const title = (entry: WorkbenchKeybind) => language.t(entry.titleKey)

  const hasOverrides = createMemo(() =>
    entries().some((entry) => entry.editable && typeof settings.keybinds.get(entry.id) === "string"),
  )

  const resetAll = () => {
    stop()
    for (const entry of entries()) {
      if (entry.editable) settings.keybinds.reset(entry.id)
    }
    showToast({
      title: language.t("settings.shortcuts.reset.toast.title"),
      description: language.t("settings.shortcuts.reset.toast.description"),
    })
  }

  const used = createMemo(() => {
    const map = new Map<string, { id: string; title: string }[]>()

    const add = (key: string, value: { id: string; title: string }) => {
      const list = map.get(key)
      if (!list) {
        map.set(key, [value])
        return
      }
      list.push(value)
    }

    for (const entry of entries()) {
      const config = fixedKeybind(entry) ?? command.keybind(entry.id)
      for (const sig of signatures(config)) {
        add(sig, { id: entry.id, title: title(entry) })
      }
    }

    return map
  })

  const setKeybind = (id: string, keybind: string) => settings.keybinds.set(id, keybind)

  useKeyCapture({
    active: () => store.active,
    stop,
    set: setKeybind,
    used,
    language,
  })

  onCleanup(() => {
    if (store.active) command.keybinds(true)
  })

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10 sm:pb-10">
      <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
        <div class="flex flex-col gap-4 pt-6 pb-6 max-w-[720px]">
          <div class="flex items-center justify-between gap-4">
            <h2 class="text-16-medium text-text-strong">{language.t("settings.shortcuts.title")}</h2>
            <Button size="small" variant="secondary" onClick={resetAll} disabled={!hasOverrides()}>
              {language.t("settings.shortcuts.reset.button")}
            </Button>
          </div>
        </div>
      </div>

      <div class="max-w-[720px]">
        <SettingsList>
          <For each={entries()}>
            {(entry) => (
              <div class="flex items-center justify-between gap-4 py-3 border-b border-border-weak-base last:border-none">
                <span class="text-14-regular text-text-strong">{title(entry)}</span>
                <Show
                  when={entry.editable}
                  fallback={
                    <span class="h-8 px-3 flex items-center rounded-md bg-surface-base text-12-regular text-text-subtle">
                      {formatKeybind(fixedKeybind(entry) ?? "", language.t)}
                    </span>
                  }
                >
                  <button
                    type="button"
                    data-keybind-id={entry.id}
                    classList={{
                      "h-8 px-3 rounded-md text-12-regular": true,
                      "bg-surface-base text-text-subtle hover:bg-surface-raised-base-hover active:bg-surface-raised-base-active":
                        store.active !== entry.id,
                      "border border-border-weak-base bg-surface-inset-base text-text-weak": store.active === entry.id,
                    }}
                    onClick={() => start(entry.id)}
                  >
                    <Show
                      when={store.active === entry.id}
                      fallback={command.keybind(entry.id) || language.t("settings.shortcuts.unassigned")}
                    >
                      {language.t("settings.shortcuts.pressKeys")}
                    </Show>
                  </button>
                </Show>
              </div>
            )}
          </For>
        </SettingsList>
      </div>
    </div>
  )
}
