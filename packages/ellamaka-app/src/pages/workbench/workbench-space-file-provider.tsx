import { FileProvider, type FileSource } from "@/context/file"
import { useServerSDK } from "@/context/server-sdk"
import { Show, createMemo, type JSX } from "solid-js"
import { GENERAL_TAB_PATH } from "./workbench-store"
import { createSpaceQuery } from "./space-query"

/** Space files are independent of Panel directories and never acquire a runtime. */
export function WorkbenchSpaceFileProvider(props: { spacePath: string; children: JSX.Element }) {
  const sdk = useServerSDK()
  const scope = createMemo(() => (props.spacePath === GENERAL_TAB_PATH ? undefined : { path: props.spacePath }))
  return (
    <Show when={scope()} keyed>
      {({ path: spacePath }) => {
        const query = createSpaceQuery(sdk.client)
        const source: FileSource = {
          directory: spacePath,
          list: (path) => query.list(spacePath, path),
          read: (path) => query.read(spacePath, path),
          listen: (receive) => sdk.event.on(spacePath, receive),
        }
        return <FileProvider source={source}>{props.children}</FileProvider>
      }}
    </Show>
  )
}
