import FileTree from "@/components/file-tree"
import { WorkbenchSpaceFileProvider } from "../workbench-space-file-provider"
import { fileTreePanelIdentity } from "./file-tree-panel-identity"
import type { FileNode } from "@opencode-ai/sdk/v2"
import { Show, createMemo } from "solid-js"
import { createSpaceMount } from "./space-mount"

export function FileTreePanel(props: { directory: string; active?: boolean; onFileClick: (file: FileNode) => void }) {
  const identity = createMemo(() => fileTreePanelIdentity(props.directory))

  return (
    <Show when={identity()} keyed>
      {(directory) => {
        const mounted = createSpaceMount(() => props.active ?? true)
        return (
          <Show when={mounted()}>
            <WorkbenchSpaceFileProvider spacePath={directory.path}>
              <div class="flex flex-col min-h-0 h-full bg-v2-background-bg-base">
                <div class="flex-1 min-h-0 overflow-y-auto workbench-tree-scroll px-1.5 py-1">
                  <FileTree path={directory.path} onFileClick={props.onFileClick} />
                </div>
              </div>
            </WorkbenchSpaceFileProvider>
          </Show>
        )
      }}
    </Show>
  )
}
