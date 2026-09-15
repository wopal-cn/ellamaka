import { SessionComposerRegion } from "@/pages/session/composer"
import type { SessionComposerState } from "@/pages/session/composer/session-composer-state"
import type { FollowupDraft } from "@/components/prompt-input/submit"

/**
 * Panel Chat Composer — thin adapter wrapping the official SessionComposerRegion.
 *
 * Uses placement="dock" (not "inline") so the composer renders in normal mode
 * rather than "new-session" variant. The "inline" placement forces variant="new-session"
 * which is only correct for new sessions, not resumed existing sessions.
 */
export function PanelChatComposer(props: {
  state: SessionComposerState
  ready: boolean
  directory: string
  inputRef: (el: HTMLDivElement) => void
  canRestorePromptFocus?: () => boolean
  setPromptDockRef: (el: HTMLDivElement) => void
  onSubmit: () => void
  onResponseSubmit: () => void
  followup?: {
    queue: () => boolean
    items: { id: string; text: string }[]
    sending?: string
    edit?: { id: string; prompt: FollowupDraft["prompt"]; context: FollowupDraft["context"] }
    onQueue: (draft: FollowupDraft) => void
    onAbort: () => void
    onSend: (id: string) => void
    onWithdraw: (id: string) => void
    onEditLoaded: () => void
  }
  revert?: {
    items: Array<{ id: string; text: string }>
    restoring?: string
    disabled: boolean
    onRestore: (id: string) => void
  }
  /** Draft-session adoption callback; see createPromptSubmit. */
  adoptSession?: (directory: string, session: { id: string }) => Promise<boolean> | boolean
}) {
  return (
    <div class="contents [&_[data-component=session-prompt-dock]]:!bg-v2-background-bg-deep">
      <SessionComposerRegion
        state={props.state}
        ready={props.ready}
        centered={false}
        placement="dock"
        inputRef={props.inputRef}
        canRestorePromptFocus={props.canRestorePromptFocus}
        newSessionWorktree={props.directory}
        onNewSessionWorktreeReset={() => {}}
        onSubmit={props.onSubmit}
        onResponseSubmit={props.onResponseSubmit}
        setPromptDockRef={props.setPromptDockRef}
        followup={props.followup}
        revert={props.revert}
        adoptSession={props.adoptSession}
      />
    </div>
  )
}
