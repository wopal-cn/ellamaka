import { createEffect, createSignal, onCleanup, Show, type ParentProps } from "solid-js"

type SetupFacts = { locked: boolean; completed: boolean }

export function StartupGate(
  props: ParentProps<{
    inspect: () => Promise<SetupFacts>
    path: () => string
    navigate: (path: string) => void
  }>,
) {
  const [facts, setFacts] = createSignal<SetupFacts>()
  const [failed, setFailed] = createSignal(false)
  const [attempt, setAttempt] = createSignal(0)
  createEffect(() => {
    attempt()
    let active = true
    setFacts(undefined)
    setFailed(false)
    void props.inspect().then(
      (result) => {
        if (active) setFacts(result)
      },
      () => {
        if (active) setFailed(true)
      },
    )
    onCleanup(() => {
      active = false
    })
  })
  let previousPath = props.path()
  createEffect(() => {
    const path = props.path()
    const leavingOnboarding = previousPath.startsWith("/onboarding") && !path.startsWith("/onboarding")
    previousPath = path
    if (leavingOnboarding) {
      setFacts(undefined)
      setAttempt((n) => n + 1)
    }
  })
  const allowed = () => {
    const current = facts()
    if (!current) return false
    const onboarding = props.path().startsWith("/onboarding")
    return onboarding || (current.locked && current.completed && props.path() !== "/startup")
  }
  createEffect(() => {
    const current = facts()
    if (!current) return
    const path = props.path()
    if ((!current.locked || !current.completed) && !path.startsWith("/onboarding")) props.navigate("/onboarding")
    else if (current.locked && current.completed && path === "/startup") props.navigate("/workbench")
  })
  return (
    <Show
      when={allowed()}
      fallback={
        <div class="h-dvh w-screen flex flex-col items-center justify-center bg-background-base gap-4">
          <Show when={failed()} fallback={<span>正在检查启动状态…</span>}>
            <span>无法读取初始化状态，请重试。</span>
            <button type="button" onClick={() => setAttempt((n) => n + 1)}>
              重试
            </button>
          </Show>
        </div>
      }
    >
      {props.children}
    </Show>
  )
}
