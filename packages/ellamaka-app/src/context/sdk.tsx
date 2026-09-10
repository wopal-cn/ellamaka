import { createSimpleContext } from "@wopal/ui/context"
import { createContext, createEffect, type Accessor, type ParentProps, useContext } from "solid-js"
import { useServerSDK } from "./server-sdk"

const SDKDirectoryContext = createContext<Accessor<string>>()
const SDKRuntimeContext = createContext<Accessor<boolean>>()

export function useSDKDirectory() {
  return useContext(SDKDirectoryContext)
}

export function useSDKRuntime() {
  return useContext(SDKRuntimeContext)
}

const sdkContext = createSimpleContext({
  name: "SDK",
  init: (props: { directory: string; runtime?: boolean }) => {
    const serverSDK = useServerSDK()
    const sdk = serverSDK.createDirSdkContext(props.directory)

    createEffect(() => {
      if (props.runtime ?? true) sdk.activate()
    })

    return sdk
  },
})

export const useSDK = sdkContext.use
const SDKContextProvider = sdkContext.provider

export function SDKProvider(props: ParentProps<{ directory: string; runtime?: boolean }>) {
  return (
    <SDKDirectoryContext.Provider value={() => props.directory}>
      <SDKRuntimeContext.Provider value={() => props.runtime ?? true}>
        <SDKContextProvider {...props} />
      </SDKRuntimeContext.Provider>
    </SDKDirectoryContext.Provider>
  )
}
