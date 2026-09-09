import { beforeAll, describe, expect, mock, test } from "bun:test"

let shouldListRoot: typeof import("./file-tree").shouldListRoot
let shouldListExpanded: typeof import("./file-tree").shouldListExpanded
let dirsToExpand: typeof import("./file-tree").dirsToExpand
let fileTreeRowTextClass: typeof import("./file-tree").fileTreeRowTextClass

beforeAll(async () => {
  mock.module("@solidjs/router", () => ({
    useNavigate: () => () => undefined,
    useParams: () => ({}),
  }))
  mock.module("@/context/file", () => ({
    useFile: () => ({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      normalize: (p: string) => p,
      tree: {
        state: () => undefined,
        list: () => Promise.resolve(),
        children: () => [
          { name: "a.md", path: "/tmp/a.md", absolute: "/tmp/a.md", type: "file", ignored: false },
          { name: "b.md", path: "/tmp/b.md", absolute: "/tmp/b.md", type: "file", ignored: true },
        ],
        expand: () => {},
        collapse: () => {},
      },
    }),
  }))
  mock.module("@/context/sdk", () => ({
    useSDK: () => ({ directory: "/tmp" }),
    SDKProvider: (props: { children?: unknown }) => props.children,
  }))
  mock.module("@wopal/ui/collapsible", () => ({
    Collapsible: {
      Trigger: (props: { children?: unknown }) => props.children,
      Content: (props: { children?: unknown }) => props.children,
    },
  }))
  mock.module("@wopal/ui/file-icon", () => ({ FileIcon: () => null }))
  mock.module("@wopal/ui/icon", () => ({ Icon: () => null }))
  mock.module("@wopal/ui/tooltip", () => ({ Tooltip: (props: { children?: unknown }) => props.children }))
  const mod = await import("./file-tree")
  shouldListRoot = mod.shouldListRoot
  shouldListExpanded = mod.shouldListExpanded
  dirsToExpand = mod.dirsToExpand
  fileTreeRowTextClass = mod.fileTreeRowTextClass
})

describe("file tree fetch discipline", () => {
  test("root lists on mount unless already loaded or loading", () => {
    expect(shouldListRoot({ level: 0 })).toBe(true)
    expect(shouldListRoot({ level: 0, dir: { loaded: true } })).toBe(false)
    expect(shouldListRoot({ level: 0, dir: { loading: true } })).toBe(false)
    expect(shouldListRoot({ level: 1 })).toBe(false)
  })

  test("nested dirs list only when expanded and stale", () => {
    expect(shouldListExpanded({ level: 1 })).toBe(false)
    expect(shouldListExpanded({ level: 1, dir: { expanded: false } })).toBe(false)
    expect(shouldListExpanded({ level: 1, dir: { expanded: true } })).toBe(true)
    expect(shouldListExpanded({ level: 1, dir: { expanded: true, loaded: true } })).toBe(false)
    expect(shouldListExpanded({ level: 1, dir: { expanded: true, loading: true } })).toBe(false)
    expect(shouldListExpanded({ level: 0, dir: { expanded: true } })).toBe(false)
  })

  test("allowed auto-expand picks only collapsed dirs", () => {
    const expanded = new Set<string>()
    const filter = { dirs: new Set(["src", "src/components"]) }

    const first = dirsToExpand({
      level: 0,
      filter,
      expanded: (dir) => expanded.has(dir),
    })

    expect(first).toEqual(["src", "src/components"])

    for (const dir of first) expanded.add(dir)

    const second = dirsToExpand({
      level: 0,
      filter,
      expanded: (dir) => expanded.has(dir),
    })

    expect(second).toEqual([])
    expect(dirsToExpand({ level: 1, filter, expanded: () => false })).toEqual([])
  })
})

describe("file tree row text tokens", () => {
  test("normal rows use the session-tree v2 text token", () => {
    expect(fileTreeRowTextClass({ ignored: false, active: false })).toBe("text-v2-text-text-base")
  })

  test("ignored rows use the dimmest Nord text step without italic", () => {
    expect(fileTreeRowTextClass({ ignored: true, active: false })).toBe("text-text-weaker")
    expect(fileTreeRowTextClass({ ignored: true, active: false })).not.toContain("italic")
  })

  test("normal rows are never italic nor weaker", () => {
    expect(fileTreeRowTextClass({ ignored: false, active: false })).not.toContain("italic")
    expect(fileTreeRowTextClass({ ignored: false, active: false })).not.toContain("weaker")
    expect(fileTreeRowTextClass({ ignored: false, active: true })).not.toContain("italic")
  })

  test("active (git status colored) rows keep their inline color only", () => {
    expect(fileTreeRowTextClass({ ignored: false, active: true })).toBe("")
    expect(fileTreeRowTextClass({ ignored: true, active: true })).toBe("")
  })
})
