import type { DesktopMenuAction } from "@wopal/ellamaka-app/desktop-menu"

export type InitStep = { phase: "server_waiting" } | { phase: "sqlite_waiting" } | { phase: "done" }

export type ServerReadyData = {
  url: string
  username: string | null
  password: string | null
}

export type SqliteMigrationProgress = { type: "InProgress"; value: number } | { type: "Done" }

export type SidecarRuntimeStatus = "starting" | "ready" | "lost" | "restarting" | "failed" | "stopped"

export type SidecarTerminalReason = "user" | "update" | "quit"

export type SidecarRuntimeState = {
  generation: number
  status: SidecarRuntimeStatus
  connection?: { url: string; username: string; password: string }
  attempt: number
  nextRetryAt?: number
  errorCode?: string
}

export type LinuxDisplayBackend = "wayland" | "auto"
export type TitlebarTheme = {
  mode: "light" | "dark"
}
export type WindowConfig = {
  updaterEnabled: boolean
  version: string
  /** The standard-HTTP DSH proxy origin (packaged iframe target); absent before ready. */
  dshProxyOrigin?: string
}

export type FatalRendererError = {
  error: string
  url: string
  version?: string
  platform: string
  os?: string
}

export type OnboardingProgress = {
  step: string
  phase?: string
  percent?: number
  message?: string
  suggestion?: string
  details?: string
}

export type OnboardingStepResult = {
  status: "completed" | "reused" | "skipped" | "failed"
  result?: Record<string, unknown>
  error?: {
    code?: string
    message?: string
    suggestion?: string
    details?: string
  }
}

export type ElectronAPI = {
  getOnboardingMode: () => Promise<{ mode: "onboarding" | "workbench" }>
  onboardingGetState: () => Promise<import("../main/onboarding-state").OnboardingState | null>
  onboardingSetCurrentStep: (
    step: import("../shared/onboarding-constants").OnboardingStepName,
  ) => Promise<{ status: string; currentStep?: string; message?: string }>
  onboardingExecuteStep: (
    step: import("../shared/onboarding-constants").OnboardingStepName | "github-auth",
    input?: unknown,
  ) => Promise<OnboardingStepResult>
  onboardingComplete: () => Promise<OnboardingStepResult>
  onboardingTransitionToWorkbench: () => Promise<{ status: "ok" } | { status: "error"; message: string }>
  onboardingProbe: (kind: string) => Promise<Record<string, unknown>>
  onboardingSetWopalHome: (path: string) => Promise<{ status: string; homePath?: string; message?: string }>
  onboardingCancelStep: () => Promise<{ status: string }>
  onboardingRendererLog: (message: string) => Promise<{ status: string }>
  onOnboardingProgress: (cb: (progress: OnboardingProgress) => void) => () => void

  killSidecar: () => Promise<void>
  installCli: () => Promise<string>
  awaitInitialization: (onStep: (step: InitStep) => void) => Promise<ServerReadyData>
  getWindowConfig: () => Promise<WindowConfig>
  consumeInitialDeepLinks: () => Promise<string[]>
  getDisplayBackend: () => Promise<LinuxDisplayBackend | null>
  setDisplayBackend: (backend: LinuxDisplayBackend | null) => Promise<void>
  parseMarkdownCommand: (markdown: string) => Promise<string>
  checkAppExists: (appName: string) => Promise<boolean>
  storeGet: (name: string, key: string) => Promise<string | null>
  storeSet: (name: string, key: string, value: string) => Promise<void>
  storeDelete: (name: string, key: string) => Promise<void>
  storeClear: (name: string) => Promise<void>
  storeKeys: (name: string) => Promise<string[]>
  storeLength: (name: string) => Promise<number>

  getWindowCount: () => Promise<number>
  onSqliteMigrationProgress: (cb: (progress: SqliteMigrationProgress) => void) => () => void
  onMenuCommand: (cb: (id: string) => void) => () => void
  onDeepLink: (cb: (urls: string[]) => void) => () => void

  openDirectoryPicker: (opts?: {
    multiple?: boolean
    title?: string
    defaultPath?: string
  }) => Promise<string | string[] | null>
  openFilePicker: (opts?: {
    multiple?: boolean
    title?: string
    defaultPath?: string
    accept?: string[]
    extensions?: string[]
  }) => Promise<string | string[] | null>
  saveFilePicker: (opts?: { title?: string; defaultPath?: string }) => Promise<string | null>
  openLink: (url: string) => void
  openPath: (path: string, app?: string) => Promise<void>
  readClipboardImage: () => Promise<{ buffer: ArrayBuffer; width: number; height: number } | null>
  showNotification: (title: string, body?: string, href?: string) => void
  onNotificationClick: (cb: (href: string) => void) => () => void
  getWindowFocused: () => Promise<boolean>
  setWindowFocus: () => Promise<void>
  showWindow: () => Promise<void>
  relaunch: () => void
  getZoomFactor: () => Promise<number>
  setZoomFactor: (factor: number) => Promise<void>
  onZoomFactorChanged: (cb: (factor: number) => void) => () => void
  setTitlebar: (theme: TitlebarTheme) => Promise<void>
  runDesktopMenuAction: (action: DesktopMenuAction) => Promise<void>
  loadingWindowComplete: () => void
  runUpdater: (alertOnFail: boolean) => Promise<void>
  checkUpdate: () => Promise<{ updateAvailable: boolean; version?: string }>
  installUpdate: () => Promise<void>
  setBackgroundColor: (color: string) => Promise<void>
  exportDebugLogs: () => Promise<string>
  recordFatalRendererError: (error: FatalRendererError) => Promise<void>
  getSidecarState: () => Promise<SidecarRuntimeState>
  onSidecarState: (cb: (state: SidecarRuntimeState) => void) => () => void
  restartSidecar: () => Promise<void>
  saveRecentModel: (model: { providerID: string; modelID: string } | string) => Promise<void>
}
