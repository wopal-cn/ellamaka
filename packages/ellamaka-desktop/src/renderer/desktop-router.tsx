import { createMemoryHistory, MemoryRouter, type BaseRouterProps } from "@solidjs/router"
import type { Component } from "solid-js"

const desktopHistory = createMemoryHistory()
desktopHistory.set({ value: "/startup", replace: true, scroll: false })

// Forward AppInterface's root prop so its provider boundary remains intact.
export const DesktopRouter: Component<BaseRouterProps> = (props) => <MemoryRouter {...props} history={desktopHistory} />
