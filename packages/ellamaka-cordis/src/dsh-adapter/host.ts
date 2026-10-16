let initialization: Promise<unknown> | undefined

/** The product host owns startup; instances only wait for its shared outcome. */
export function trackDshToolsInitialization<T>(work: Promise<T>): Promise<T> {
  initialization = work
  const settled = () => {
    if (initialization === work) initialization = undefined
  }
  void work.then(settled, settled)
  return work
}

export async function waitForDshToolsInitialization(): Promise<void> {
  await initialization
}
