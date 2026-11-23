import { createContext, useContext, type ParentProps } from "solid-js"
import { createSignal } from "solid-js"
import type { usePrompt } from "@/context/prompt"
import type { useComments } from "@/context/comments"

type PromptApi = ReturnType<typeof usePrompt>
type CommentsApi = ReturnType<typeof useComments>

type WorkbenchPromptRegistry = {
  registerPrompt: (panelID: string, api: PromptApi) => void
  unregisterPrompt: (panelID: string) => void
  registerComments: (panelID: string, api: CommentsApi) => void
  unregisterComments: (panelID: string) => void
  setActivePanel: (panelID: string | undefined) => void
  activePrompt: () => PromptApi | undefined
  activeComments: () => CommentsApi | undefined
}

const WorkbenchPromptRegistryContext = createContext<WorkbenchPromptRegistry>()

/**
 * Bridge between the floating file viewer and the active chat Panel's prompt
 * context. Each chat Panel keeps its own PromptProvider/CommentsProvider
 * instance (per-Panel state isolation, AGENTS.md §5.1); this registry lets the
 * viewer address whichever Panel is currently active without sharing a single
 * provider instance (which would leak prompt drafts across Panels) and without
 * storage-event coupling (makePersisted does not sync across instances).
 */
export function WorkbenchPromptRegistryProvider(props: ParentProps) {
  const prompts = new Map<string, PromptApi>()
  const comments = new Map<string, CommentsApi>()
  const [activePanelID, setActivePanelID] = createSignal<string | undefined>(undefined)

  const value: WorkbenchPromptRegistry = {
    registerPrompt: (panelID, api) => {
      prompts.set(panelID, api)
    },
    unregisterPrompt: (panelID) => {
      prompts.delete(panelID)
    },
    registerComments: (panelID, api) => {
      comments.set(panelID, api)
    },
    unregisterComments: (panelID) => {
      comments.delete(panelID)
    },
    setActivePanel: (panelID) => {
      setActivePanelID(panelID)
    },
    activePrompt: () => {
      const id = activePanelID()
      return id ? prompts.get(id) : undefined
    },
    activeComments: () => {
      const id = activePanelID()
      return id ? comments.get(id) : undefined
    },
  }

  return (
    <WorkbenchPromptRegistryContext.Provider value={value}>{props.children}</WorkbenchPromptRegistryContext.Provider>
  )
}

export function useWorkbenchPromptRegistry() {
  const value = useContext(WorkbenchPromptRegistryContext)
  if (!value) throw new Error("useWorkbenchPromptRegistry must be used within WorkbenchPromptRegistryProvider")
  return value
}
