import { createMemo, type Accessor } from "solid-js"

/** Runtime lifetime, not persisted layout: a visited Space stays mounted until closed. */
export function createSpaceMount(active: Accessor<boolean>) {
  return createMemo((visited) => visited || active(), false)
}
