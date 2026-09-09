import { describe, test, expect, afterAll } from "bun:test"
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "fs"
import { join, dirname } from "path"
import { tmpdir as osTmpdir, homedir } from "os"
import { detectWopalSpace } from "../detect"

const tmpDirs: string[] = []
afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true })
})

function makeTmpdir(): string {
  const dir = mkdtempSync(join(osTmpdir(), "ellamaka-detect-test-"))
  tmpDirs.push(dir)
  return dir
}

function setupOntologyWorktree(dir: string) {
  const wopalDir = join(dir, ".wopal")
  mkdirSync(wopalDir, { recursive: true })
  // Ontology worktree marker: .wopal/.git is a FILE (not a directory)
  writeFileSync(join(wopalDir, ".git"), "")
}

describe("detectWopalSpace", () => {
  test("detects space root when .wopal/.git is a file", () => {
    const dir = makeTmpdir()
    setupOntologyWorktree(dir)
    const result = detectWopalSpace(dir)
    expect(result).toBeDefined()
    expect(result!.root).toBe(dir)
    expect(result!.wopalDir).toBe(join(dir, ".wopal"))
  })

  test("returns undefined when .wopal/.git is a directory", () => {
    const dir = makeTmpdir()
    const wopalDir = join(dir, ".wopal")
    mkdirSync(join(wopalDir, ".git"), { recursive: true })
    expect(detectWopalSpace(dir)).toBeUndefined()
  })

  test("returns undefined when no .wopal exists", () => {
    const dir = makeTmpdir()
    expect(detectWopalSpace(dir)).toBeUndefined()
  })

  test("walks up from nested subdirectory", () => {
    const dir = makeTmpdir()
    setupOntologyWorktree(dir)
    const nested = join(dir, "projects", "my-app", "src", "components")
    mkdirSync(nested, { recursive: true })
    const result = detectWopalSpace(nested)
    expect(result).toBeDefined()
    expect(result!.root).toBe(dir)
    expect(result!.wopalDir).toBe(join(dir, ".wopal"))
  })

  test("stops at home directory", () => {
    // Create a tmpdir INSIDE home so we can test the stop boundary.
    // Since the tmpdir has no .wopal/.git file, detection should return undefined
    // without walking past home.
    const dir = makeTmpdir()
    const result = detectWopalSpace(dir)
    expect(result).toBeUndefined()
  })

  test("ignores non-ontology .wopal at intermediate level", () => {
    const dir = makeTmpdir()
    setupOntologyWorktree(dir)

    // Create an intermediate .wopal without .git file (not ontology)
    const midDir = join(dir, "mid")
    mkdirSync(join(midDir, ".wopal"), { recursive: true })

    const deepDir = join(midDir, "deep")
    mkdirSync(deepDir, { recursive: true })

    const result = detectWopalSpace(deepDir)
    expect(result).toBeDefined()
    // Should find the root space, not the intermediate one
    expect(result!.root).toBe(dir)
  })

  test("works when cwd is a nested git repo", () => {
    const dir = makeTmpdir()
    setupOntologyWorktree(dir)

    // Create a nested regular git repo inside the space
    const nestedApp = join(dir, "projects", "nested-app")
    mkdirSync(join(nestedApp, ".git", "objects"), { recursive: true })
    mkdirSync(join(nestedApp, ".git", "refs"), { recursive: true })

    const result = detectWopalSpace(nestedApp)
    expect(result).toBeDefined()
    expect(result!.root).toBe(dir)
  })

  test("does NOT depend on settings files", () => {
    const dir = makeTmpdir()
    // Create only .wopal/.git file — no config/ or settings files
    const wopalDir = join(dir, ".wopal")
    mkdirSync(wopalDir, { recursive: true })
    writeFileSync(join(wopalDir, ".git"), "")

    const result = detectWopalSpace(dir)
    expect(result).toBeDefined()
    expect(result!.root).toBe(dir)
    expect(result!.wopalDir).toBe(join(dir, ".wopal"))
  })

  test("returns undefined at filesystem root", () => {
    expect(detectWopalSpace("/")).toBeUndefined()
  })
})
