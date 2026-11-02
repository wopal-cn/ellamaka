/** @jsx h */
import { expect, test } from "bun:test"
import h from "solid-js/h"
import { render } from "solid-js/web"
import type { SetupInspect } from "../setup-client"
import { GithubAuthStep } from "./github-auth"

function facts(configured: boolean, step: "done" | "failed" = "done", source = "gh"): SetupInspect {
  return {
    home: {
      path: "/home",
      binding: {
        mode: "normal",
        source: "shell",
        path: "/home",
        locked: true,
        selectable: false,
        persisted: true,
      },
      writable: true,
      foundation: { ready: true, missing: [] },
      settings: { present: false, valid: true, ellamaka: { present: false, valid: false } },
      capabilities: { ready: false, missing: [] },
    },
    ontology: { status: "missing", items: [] },
    space: { status: "missing", items: [], availableTypes: [] },
    credentials: {
      github: configured ? { configured: true, source, account: "octocat" } : { configured: false },
      providers: [],
    },
    state: {
      status: "ok",
      path: "/home/state",
      completed: false,
      currentStep: "github",
      steps: { github: step },
    },
    goals: ["foundation", "github"],
    fingerprint: "0123456789abcdef",
  }
}

test("a stale fork failure does not turn a live gh identity back into an authentication failure", () => {
  const host = document.createElement("div")
  document.body.appendChild(host)
  const dispose = render(
    () => (
      <GithubAuthStep
        facts={facts(true, "failed")}
        working={false}
        onRefreshIdentity={() => {}}
        onContinueClone={() => {}}
      />
    ),
    host,
  )

  expect(host.querySelector("#onboarding-github-token")).toBeNull()
  expect(host.textContent).toContain("GitHub 身份已经可用")
  expect(host.textContent).toContain("octocat")
  dispose()
  host.remove()
})

test("a healthy GitHub identity stays read-only in the completed identity view", () => {
  const host = document.createElement("div")
  document.body.appendChild(host)
  const dispose = render(
    () => (
      <GithubAuthStep facts={facts(true)} working={false} onRefreshIdentity={() => {}} onContinueClone={() => {}} />
    ),
    host,
  )

  expect(host.querySelector("#onboarding-github-token")).toBeNull()
  expect(host.textContent).toContain("GitHub 身份已经可用")
  dispose()
  host.remove()
})

test("missing identity guides gh login first and still offers explicit clone continuation", () => {
  const host = document.createElement("div")
  document.body.appendChild(host)
  const dispose = render(
    () => (
      <GithubAuthStep facts={facts(false)} working={false} onRefreshIdentity={() => {}} onContinueClone={() => {}} />
    ),
    host,
  )

  expect(host.textContent).toContain("gh auth login")
  expect(host.textContent).toContain("重新检测 GitHub 登录")
  expect(host.textContent).toContain("放弃 Fork，使用 Clone")
  expect(host.querySelector("#onboarding-github-token")).toBeNull()
  dispose()
  host.remove()
})

test("an inherited token does not bypass the local gh login requirement for Fork", () => {
  const host = document.createElement("div")
  document.body.appendChild(host)
  const dispose = render(
    () => (
      <GithubAuthStep
        facts={facts(true, "done", "process-env")}
        working={false}
        onRefreshIdentity={() => {}}
        onContinueClone={() => {}}
      />
    ),
    host,
  )

  expect(host.textContent).toContain("本机 gh 尚未登录")
  expect(host.textContent).toContain("gh auth login")
  expect(host.textContent).toContain("放弃 Fork，使用 Clone")
  dispose()
  host.remove()
})
