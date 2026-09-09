import { createEffect } from "solid-js"
import { useLocation, useNavigate } from "@solidjs/router"
import { Dialog } from "@wopal/ui/dialog"
import { Button } from "@wopal/ui/button"
import { useDialog } from "@wopal/ui/context/dialog"
import { useServerSDK } from "@/context/server-sdk"
import { useLanguage } from "@/context/language"
import { parseWorkbenchSessionLink } from "@/utils/workbench-session-link"
import { useWorkbenchState } from "./view-store"
import { useWorkbenchActions } from "./workbench-actions"
import { useSpaceStore } from "./space-store"
import { coordinateWorkbenchSessionLink, type WorkbenchSessionGroupSummary } from "./workbench-session-deep-link-core"

// ── Workbench-mounted coordinator ──────────────────────────────────────
// Runs inside the Workbench Provider tree. Waits for the persisted Workbench
// state and the registered Space list, parses the `?session=` query, resolves
// the target Space via the server session-groups projection, then delegates
// the Tab/Panel mutation to `coordinateWorkbenchSessionLink` (pure logic).

function OverwriteConfirmDialog(props: { index: number; onConfirm: () => void; onCancel: () => void }) {
  const language = useLanguage()
  const t = (k: string, p?: Record<string, string | number | boolean>) =>
    language.t(k as Parameters<typeof language.t>[0], p)
  return (
    <Dialog title={t("workbench.panel.overwriteTitle")} fit>
      <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3 min-w-[320px]">
        <div class="flex flex-col gap-1">
          <span class="text-14-regular text-text-strong">
            {t("workbench.panel.overwriteConfirmText", { index: String(props.index) })}
          </span>
          <span class="text-12-regular text-text-muted">{t("workbench.panel.overwriteConfirmHint")}</span>
        </div>
        <div class="flex justify-end gap-2">
          <Button variant="ghost" size="large" onClick={props.onCancel}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" size="large" onClick={props.onConfirm}>
            {t("common.confirm")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

export function WorkbenchSessionDeepLink() {
  const wb = useWorkbenchState()
  const actions = useWorkbenchActions()
  const spaceStore = useSpaceStore()
  const sdk = useServerSDK()
  const dialog = useDialog()
  const language = useLanguage()
  const location = useLocation()
  const navigate = useNavigate()
  const t = (k: string, params?: Record<string, string | number | boolean>) =>
    language.t(k as Parameters<typeof language.t>[0], params)

  let requestGeneration = 0

  const consume = () => {
    if (location.search) navigate("/workbench", { replace: true })
  }

  createEffect(() => {
    // Wait for persisted Workbench state and the registered Space list
    // before resolving the deep link (D-02).
    if (!wb.ready()) return
    if (spaceStore.spacesLoading) return
    const search = location.search
    const parsed = parseWorkbenchSessionLink(search)
    if (!parsed) return

    const myGeneration = ++requestGeneration
    const isCurrent = () => requestGeneration === myGeneration

    void (async () => {
      if (!isCurrent()) return
      let raw
      try {
        raw = await sdk.client.workbench.sessionGroups()
      } catch {
        consume()
        return
      }
      if (!isCurrent()) {
        consume()
        return
      }
      const groups: WorkbenchSessionGroupSummary[] = (raw.data?.groups ?? []).map((group) => ({
        id: group.id,
        title: group.title,
        type: group.type,
        sessions: (group.sessions ?? []).map((session) => ({
          id: session.id,
          title: session.title,
          directory: session.directory,
          directoryHealth: session.directoryHealth,
        })),
      }))

      await coordinateWorkbenchSessionLink({
        sessionID: parsed.sessionID,
        groups,
        spaces: spaceStore.spaces(),
        reveal: (input) => actions.revealSession(input),
        openTab: (space) => wb.openTab(space),
        showConfirm: (onConfirm, onCancel) => {
          const activeTab = wb.activeTab()
          const activePanelID = activeTab ? wb.spaceState(activeTab.path)?.activePanelID : undefined
          const index =
            (activePanelID
              ? wb.spaceState(activeTab!.path)?.panels.findIndex((panel) => panel.id === activePanelID)
              : -1) ?? 0
          void dialog.show(() => (
            <OverwriteConfirmDialog
              index={index + 1}
              onConfirm={() => {
                dialog.close()
                onConfirm()
              }}
              onCancel={() => {
                dialog.close()
                onCancel()
              }}
            />
          ))
        },
        setStatusMessage: (message) => wb.setStatusMessage(message),
        consume,
        t,
        isCurrent,
      })
    })()
  })

  return <></>
}
