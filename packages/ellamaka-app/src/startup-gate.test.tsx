/** @jsx h */
import { expect, test } from "bun:test"
import h from "solid-js/h"
import { render } from "solid-js/web"
import { createSignal } from "solid-js"
import { StartupGate } from "./startup-gate"

test("does not mount a stage while inspecting and directs incomplete setup to onboarding", async () => {
  let complete!: (v: { locked: boolean; completed: boolean }) => void
  const pending = new Promise<{ locked: boolean; completed: boolean }>((resolve) => (complete = resolve))
  const paths: string[] = []
  const host = document.createElement("div")
  const dispose = render(
    () => (
      <StartupGate inspect={() => pending} path={() => "/workbench"} navigate={(p) => paths.push(p)}>
        <div>WORKBENCH MOUNTED</div>
      </StartupGate>
    ),
    host,
  )
  expect(host.textContent).not.toContain("WORKBENCH MOUNTED")
  complete({ locked: true, completed: false })
  await pending
  await Promise.resolve()
  expect(paths).toEqual(["/onboarding"])
  expect(host.textContent).not.toContain("WORKBENCH MOUNTED")
  dispose()
})

test("an inspect failure never admits a stage and offers retry", async () => {
  const host = document.createElement("div")
  const dispose = render(
    () => (
      <StartupGate
        inspect={async () => {
          throw new Error("offline")
        }}
        path={() => "/workbench"}
        navigate={() => {}}
      >
        <div>WORKBENCH MOUNTED</div>
      </StartupGate>
    ),
    host,
  )
  await Promise.resolve()
  await Promise.resolve()
  expect(host.textContent).not.toContain("WORKBENCH MOUNTED")
  expect(host.querySelector("button")).not.toBeNull()
  dispose()
})

test("rechecks completion before entering workbench after onboarding", async () => {
  const [path, setPath] = createSignal("/onboarding")
  let completed = false
  let checks = 0
  const host = document.createElement("div")
  const dispose = render(
    () => (
      <StartupGate
        inspect={async () => {
          checks++
          return { locked: true, completed }
        }}
        path={path}
        navigate={(p) => setPath(p)}
      >
        <div>STAGE</div>
      </StartupGate>
    ),
    host,
  )
  await Promise.resolve()
  await Promise.resolve()
  completed = true
  setPath("/workbench")
  await Promise.resolve()
  await Promise.resolve()
  expect(checks).toBe(2)
  expect(path()).toBe("/workbench")
  dispose()
})

test("completed neutral startup enters workbench without mounting the initial route", async () => {
  const [path, setPath] = createSignal("/startup")
  const host = document.createElement("div")
  const dispose = render(
    () => (
      <StartupGate inspect={async () => ({ locked: true, completed: true })} path={path} navigate={setPath}>
        <div>STAGE</div>
      </StartupGate>
    ),
    host,
  )
  expect(host.textContent).not.toContain("STAGE")
  await Promise.resolve()
  await Promise.resolve()
  expect(path()).toBe("/workbench")
  expect(host.textContent).toContain("STAGE")
  dispose()
})
