/**
 * Queries without a directory are implicit default-cwd instance reads. They
 * are valid on legacy routes, but must stay disabled while Workbench owns
 * directory demand explicitly.
 */
export function shouldEnableInstanceQuery(input: { directory: string | null; instanceBootstrap: boolean }) {
  return !!input.directory || input.instanceBootstrap
}
