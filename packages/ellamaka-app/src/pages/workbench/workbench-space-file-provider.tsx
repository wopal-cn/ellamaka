import { FileProvider, type FileSource } from "@/context/file"
import { useServerSDK } from "@/context/server-sdk"
import { Show, createMemo, type JSX } from "solid-js"
import { GENERAL_TAB_PATH } from "./workbench-store"

/** Space files are independent of Panel directories and never acquire a runtime. */
export function WorkbenchSpaceFileProvider(props: { spacePath: string; children: JSX.Element }) {
  const sdk = useServerSDK()
  const scope = createMemo(() => (props.spacePath === GENERAL_TAB_PATH ? undefined : { path: props.spacePath }))
  return (
    <Show when={scope()} keyed>
      {({ path: spacePath }) => {
        const source: FileSource = {
          directory: spacePath,
          list: async (path) =>
            (await sdk.client.workbench.files({ spacePath, path }, { throwOnError: true })).data ?? [],
          read: async (path) =>
            (await sdk.client.workbench.fileContent({ spacePath, path }, { throwOnError: true })).data,
          listen: (receive) => sdk.event.on(spacePath, receive),
        }
        return <FileProvider source={source}>{props.children}</FileProvider>
      }}
    </Show>
  )
}
