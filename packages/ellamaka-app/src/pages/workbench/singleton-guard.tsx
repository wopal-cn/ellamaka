import { Show, createSignal, onMount, onCleanup } from "solid-js"
import type { JSX } from "solid-js"
import { useLanguage } from "@/context/language"

const LOCK_NAME = "ellamaka-workbench-instance"

type GuardState = "acquiring" | "locked" | "blocked"

export type LockRequestResult = {
  state: "locked" | "blocked"
  release?: () => void
}

type WorkbenchLocks = {
  request: (
    name: string,
    options: { ifAvailable?: boolean },
    callback: (lock: { name: string } | null) => Promise<void>,
  ) => Promise<void>
}

function isWorkbenchLocks(value: unknown): value is WorkbenchLocks {
  return !!value && typeof value === "object" && "request" in value && typeof value.request === "function"
}

export async function requestWorkbenchLock(locks: WorkbenchLocks | undefined): Promise<LockRequestResult> {
  if (!locks) return { state: "locked" }

  return new Promise<LockRequestResult>((resolve) => {
    void locks.request(LOCK_NAME, { ifAvailable: true }, async (lock) => {
      if (!lock) {
        resolve({ state: "blocked" })
        return
      }
      let release: () => void
      const hold = new Promise<void>((res) => {
        release = res
      })
      resolve({ state: "locked", release: release! })
      await hold
    })
  })
}

export function WorkbenchSingletonGuard(props: { children: JSX.Element }) {
  const language = useLanguage()
  const t = (k: string) => language.t(k)
  const [state, setState] = createSignal<GuardState>("acquiring")
  let releaseLock: (() => void) | undefined

  onMount(() => {
    const locks = Reflect.get(navigator, "locks")
    void requestWorkbenchLock(isWorkbenchLocks(locks) ? locks : undefined).then((result) => {
      setState(result.state)
      if (result.release) releaseLock = result.release
    })
  })

  onCleanup(() => {
    releaseLock?.()
  })

  return (
    <Show
      when={state() !== "blocked"}
      fallback={
        <div class="flex h-dvh flex-col items-center justify-center gap-4 bg-v2-background-bg-deep text-v2-text-text-base p-8">
          <div class="text-center max-w-md">
            <h2 class="text-18-semibold text-text-strong mb-2">{t("workbench.singleton.title")}</h2>
            <p class="text-14-regular text-text-muted">{t("workbench.singleton.message")}</p>
          </div>
        </div>
      }
    >
      <Show when={state() === "locked"}>{props.children}</Show>
    </Show>
  )
}
