// @refresh reload

import {
  ACCEPTED_FILE_EXTENSIONS,
  ACCEPTED_FILE_TYPES,
  AppBaseProviders,
  AppInterface,
  handleNotificationClick,
  loadLocaleDict,
  normalizeLocale,
  type Locale,
  type Platform,
  PlatformProvider,
  ServerConnection,
  useCommand,
} from "@wopal/ellamaka-app"
import * as Sentry from "@sentry/solid"
import type { AsyncStorage } from "@solid-primitives/storage"
import { createEffect, createMemo, createResource, createSignal, onCleanup, onMount, Show } from "solid-js"
import { render } from "solid-js/web"
import pkg from "../../package.json"
import { initI18n, t } from "./i18n"
import { resetZoom, webviewZoom, zoomIn, zoomOut } from "./webview-zoom"
import "./styles.css"
import { useTheme } from "@wopal/ui/theme"
import { DesktopRouter } from "./desktop-router"
import type { SidecarRuntimeState } from "../preload/types"
import { mapSidecarStateToAction, resolveSidecarServer } from "./sidecar-adapter"
import { OnboardingRoot } from "./onboarding/onboarding-root"

const root = document.getElementById("root")
if (import.meta.env.DEV && !(root instanceof HTMLElement)) {
  throw new Error(t("error.dev.rootNotFound"))
}

if (import.meta.env.VITE_SENTRY_DSN) {
  Sentry.init({
    dsn: import.meta.env.VITE_SENTRY_DSN,
    environment: import.meta.env.VITE_SENTRY_ENVIRONMENT ?? import.meta.env.MODE,
    release: import.meta.env.VITE_SENTRY_RELEASE ?? `desktop@${pkg.version}`,
    initialScope: {
      tags: {
        platform: "desktop",
      },
    },
    integrations: (integrations) => {
      return integrations.filter(
        (i) =>
          i.name !== "Breadcrumbs" &&
          !(
            import.meta.env.OPENCODE_CHANNEL === "prod" &&
            (i.name === "GlobalHandlers" || i.name === "BrowserApiErrors")
          ),
      )
    },
  })
}

void initI18n()

const deepLinkEvent = "ellamaka:deep-link"

const emitDeepLinks = (urls: string[]) => {
  if (urls.length === 0) return
  window.__OPENCODE__ ??= {}
  const pending = window.__OPENCODE__.deepLinks ?? []
  window.__OPENCODE__.deepLinks = [...pending, ...urls]
  window.dispatchEvent(new CustomEvent(deepLinkEvent, { detail: { urls } }))
}

const listenForDeepLinks = () => {
  void window.api.consumeInitialDeepLinks().then((urls) => emitDeepLinks(urls))
  return window.api.onDeepLink((urls) => emitDeepLinks(urls))
}

const createPlatform = (releaseVersion: () => string, dshProxyOrigin?: () => string | undefined): Platform => {
  const os = (() => {
    const ua = navigator.userAgent
    if (ua.includes("Mac")) return "macos"
    if (ua.includes("Windows")) return "windows"
    if (ua.includes("Linux")) return "linux"
    return undefined
  })()

  const runDesktopMenuAction: Platform["runDesktopMenuAction"] = (action) => {
    switch (action) {
      case "view.resetZoom":
        resetZoom()
        return
      case "view.zoomIn":
        zoomIn()
        return
      case "view.zoomOut":
        zoomOut()
        return
    }

    return window.api.runDesktopMenuAction(action)
  }

  const storage = (() => {
    const cache = new Map<string, AsyncStorage>()

    const createStorage = (name: string) => {
      const api: AsyncStorage = {
        getItem: (key: string) => window.api.storeGet(name, key),
        setItem: (key: string, value: string) => window.api.storeSet(name, key, value),
        removeItem: (key: string) => window.api.storeDelete(name, key),
        clear: () => window.api.storeClear(name),
        key: async (index: number) => (await window.api.storeKeys(name))[index],
        getLength: () => window.api.storeLength(name),
        get length() {
          return api.getLength()
        },
      }
      return api
    }

    return (name = "default.dat") => {
      const cached = cache.get(name)
      if (cached) return cached
      const api = createStorage(name)
      cache.set(name, api)
      return api
    }
  })()

  return {
    platform: "desktop",
    os,
    get version() {
      return releaseVersion()
    },
    get dshProxyOrigin() {
      return dshProxyOrigin?.()
    },

    async openDirectoryPickerDialog(opts) {
      const result = await window.api.openDirectoryPicker({
        multiple: opts?.multiple ?? false,
        title: opts?.title ?? t("desktop.dialog.chooseFolder"),
      })
      return result
    },

    async openFilePickerDialog(opts) {
      const result = await window.api.openFilePicker({
        multiple: opts?.multiple ?? false,
        title: opts?.title ?? t("desktop.dialog.chooseFile"),
        accept: opts?.accept ?? ACCEPTED_FILE_TYPES,
        extensions: opts?.extensions ?? ACCEPTED_FILE_EXTENSIONS,
      })
      return result
    },

    async saveFilePickerDialog(opts) {
      const result = await window.api.saveFilePicker({
        title: opts?.title ?? t("desktop.dialog.saveFile"),
        defaultPath: opts?.defaultPath,
      })
      return result
    },

    openLink(url: string) {
      window.api.openLink(url)
    },
    async openPath(path: string, app?: string) {
      return window.api.openPath(path, app)
    },

    back() {
      window.history.back()
    },

    forward() {
      window.history.forward()
    },

    storage,

    checkUpdate: async () => {
      const config = await window.api.getWindowConfig().catch(() => ({ updaterEnabled: false }))
      if (!config.updaterEnabled) return { updateAvailable: false }
      return window.api.checkUpdate()
    },

    updateAndRestart: async () => {
      const config = await window.api.getWindowConfig().catch(() => ({ updaterEnabled: false }))
      if (!config.updaterEnabled) return
      await window.api.installUpdate()
    },

    exportDebugLogs: () => window.api.exportDebugLogs(),

    recordFatalRendererError: (error) => window.api.recordFatalRendererError(error),

    restart: async () => {
      await window.api.killSidecar().catch(() => undefined)
      window.api.relaunch()
    },

    notify: async (title, description, href) => {
      const focused = await window.api.getWindowFocused().catch(() => document.hasFocus())
      if (focused) return

      window.api.showNotification(title, description ?? "", href)
    },

    fetch: (input, init) => {
      if (input instanceof Request) return fetch(input)
      return fetch(input, init)
    },

    getDisplayBackend: async () => {
      return window.api.getDisplayBackend().catch(() => null)
    },

    setDisplayBackend: async (backend) => {
      await window.api.setDisplayBackend(backend)
    },

    parseMarkdown: (markdown: string) => window.api.parseMarkdownCommand(markdown),

    webviewZoom,

    runDesktopMenuAction,

    checkAppExists: async (appName: string) => {
      return window.api.checkAppExists(appName)
    },

    async readClipboardImage() {
      const image = await window.api.readClipboardImage().catch(() => null)
      if (!image) return null
      const blob = new Blob([image.buffer], { type: "image/png" })
      return new File([blob], `pasted-image-${Date.now()}.png`, {
        type: "image/png",
      })
    },

    saveRecentModel: (model: { providerID: string; modelID: string } | string) => window.api.saveRecentModel(model),
  }
}

let menuTrigger = null as null | ((id: string) => void)
window.api.onMenuCommand((id) => {
  menuTrigger?.(id)
})
listenForDeepLinks()

  render(() => {
    const [windowConfig] = createResource(() => window.api.getWindowConfig().catch(() => ({ updaterEnabled: false, version: pkg.version, dshProxyOrigin: undefined })))
    const platform = createPlatform(() => windowConfig()?.version ?? pkg.version, () => windowConfig()?.dshProxyOrigin)
    document.documentElement.dataset.platform = platform.os ? `desktop-${platform.os}` : "desktop"
    const loadLocale = async () => {
    const current = await platform.storage?.("ellamaka.global.dat").getItem("language")
    const legacy = current ? undefined : await platform.storage?.().getItem("language.v1")
    const raw = current ?? legacy
    if (!raw) return
    const locale = raw.match(/"locale"\s*:\s*"([^"]+)"/)?.[1]
    if (!locale) return
    const next = normalizeLocale(locale)
    if (next !== "en") await loadLocaleDict(next)
    return next satisfies Locale
  }

  const [windowCount] = createResource(() => window.api.getWindowCount())

  const [onboardingMode] = createResource(async () => {
    const res = await window.api.getOnboardingMode().catch(() => ({ mode: "workbench" as const }))
    return res.mode
  })

  // Fetch sidecar credentials only when in workbench mode
  const [sidecar] = createResource(
    () => onboardingMode() === "workbench",
    () => window.api.awaitInitialization(() => undefined),
  )

  // Live sidecar state from Supervisor (for generation changes / restarts)
  const [sidecarState, setSidecarState] = createSignal<SidecarRuntimeState | undefined>()
  let previousGeneration = 0
  let previousSidecarServer: ServerConnection.Sidecar | undefined

  onMount(() => {
    const unsub = window.api.onSidecarState((state) => {
      setSidecarState(state)
    })
    onCleanup(unsub)
  })

  const [locale] = createResource(loadLocale)

  const initialSidecarServer = (): ServerConnection.Sidecar | undefined => {
    const data = sidecar()
    if (!data) return undefined
    return {
      displayName: "Local Server",
      type: "sidecar",
      variant: "base",
      http: {
        url: data.url,
        username: data.username ?? undefined,
        password: data.password ?? undefined,
      },
    } satisfies ServerConnection.Sidecar
  }

  const servers = createMemo(() => {
    const fallback = initialSidecarServer()
    const live = sidecarState()
    if (!live) return fallback ? [fallback] : []

    const action = mapSidecarStateToAction(live, previousGeneration)
    if (live.status === "ready") previousGeneration = live.generation
    const server = resolveSidecarServer(action, previousSidecarServer, fallback)
    if (action.action === "connect" || action.action === "reconnect") {
      previousSidecarServer = server
    }
    return server ? [server] : []
  })

  function handleClick(e: MouseEvent) {
    const link = (e.target as HTMLElement).closest("a.external-link") as HTMLAnchorElement | null
    if (link?.href) {
      e.preventDefault()
      platform.openLink(link.href)
    }
  }

  function Inner() {
    const cmd = useCommand()
    menuTrigger = (id) => cmd.trigger(id)

    const theme = useTheme()

    createEffect(() => {
      theme.themeId()
      theme.mode()
      const bg = getComputedStyle(document.documentElement).getPropertyValue("--background-base").trim()
      if (bg) {
        void window.api.setBackgroundColor(bg)
      }
    })

    return null
  }

  onMount(() => {
    document.addEventListener("click", handleClick)
    const unsubNotification = window.api.onNotificationClick((href) => {
      handleNotificationClick(href)
    })
    onCleanup(() => {
      document.removeEventListener("click", handleClick)
      unsubNotification()
    })
  })



  return (
    <PlatformProvider value={platform}>
      <AppBaseProviders locale={locale.latest}>
        <Show when={!onboardingMode.loading}>
          <Show
            when={onboardingMode() === "workbench"}
            fallback={<OnboardingRoot />}
          >
            <Show
              when={
                !sidecar.loading &&
                !windowConfig.loading &&
                !windowCount.loading &&
                !locale.loading
              }
            >
              {(_) => {
                return (
                  <AppInterface
                    defaultServer={ServerConnection.Key.make("sidecar")}
                    servers={servers()}
                    router={DesktopRouter}
                  >
                    <Inner />
                  </AppInterface>
                )
              }}
            </Show>
          </Show>
        </Show>
      </AppBaseProviders>
    </PlatformProvider>
  )
}, root!)
