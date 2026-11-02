import { expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createSpaceFormState } from "./create-space"

test("Space form keeps user input when live facts refresh and tracks Ontology archetypes", () => {
  createRoot((dispose) => {
    const [types, setTypes] = createSignal([
      { type: "coding", description: "工程研发空间" },
      { type: "content", description: "内容创作空间" },
    ])
    const form = createSpaceFormState(types)

    expect(types().map((entry) => entry.type)).toEqual(["coding", "content"])
    expect(form.spaceType()).toBe("coding")

    form.setSpacePath("/tmp/my-space")
    form.setSpaceName("my-space")
    form.setSpaceType("content")

    setTypes([
      { type: "coding", description: "工程研发空间（已刷新）" },
      { type: "content", description: "内容创作空间（已刷新）" },
    ])

    expect(form.spacePath()).toBe("/tmp/my-space")
    expect(form.spaceName()).toBe("my-space")
    expect(form.spaceType()).toBe("content")

    setTypes([{ type: "coding", description: "工程研发空间" }])
    expect(form.spaceType()).toBe("coding")
    dispose()
  })
})
