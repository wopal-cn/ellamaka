import { createContext, useContext, type ParentComponent } from "solid-js"

/**
 * Bridge from the Workbench Shell's inspector surface state to read-only
 * consumers (the topbar toggle). The Shell stays the single owner of surface
 * state (tabs, width, display flag); the context only derives presentation
 * facts from it, so the topbar never writes WorkbenchStore or surface state
 * directly (AGENTS.md §5.1 / §5.3).
 */
type SurfaceContextValue = {
  /** True when the inspector holds at least one tab. */
  hasTabs: () => boolean
  /** True when the inspector surface is currently visible. */
  visible: () => boolean
  /** Owned by the Shell: flips the display flag without touching tabs. */
  toggleVisibility: () => void
}

const WorkbenchSurfaceContext = createContext<SurfaceContextValue>()

export function useWorkbenchSurface(): SurfaceContextValue {
  const ctx = useContext(WorkbenchSurfaceContext)
  if (!ctx) throw new Error("useWorkbenchSurface must be used within WorkbenchSurfaceProvider")
  return ctx
}

export const WorkbenchSurfaceProvider: ParentComponent<SurfaceContextValue> = (props) => (
  <WorkbenchSurfaceContext.Provider
    value={{ hasTabs: props.hasTabs, visible: props.visible, toggleVisibility: props.toggleVisibility }}
  >
    {props.children}
  </WorkbenchSurfaceContext.Provider>
)
