/** Start the Global Event stream after mount without waiting for a paint frame. */
export function scheduleServerSdkEventStart(
  start: () => Promise<unknown> | undefined,
  schedule: (callback: () => void, delay: number) => ReturnType<typeof setTimeout> | number = setTimeout,
  cancel: (id: ReturnType<typeof setTimeout> | number) => void = (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
) {
  const timer = schedule(() => void start(), 0)
  return () => cancel(timer)
}
