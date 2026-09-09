import { describe, test, expect, afterAll } from "bun:test"
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "fs"
import { join } from "path"
import { tmpdir as osTmpdir } from "os"
import { detectWopalSpace } from "../detect"
import { BINARY_NAME, BINARY_TITLE, VERSION_PREFIX, UI_UPSTREAM_URL } from "../branding"
import { ellamaka, wordmark } from "../logo"

const tmpDirs: string[] = []
afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true })
})

function makeTmpdir(): string {
  const dir = mkdtempSync(join(osTmpdir(), "ellamaka-test-"))
  tmpDirs.push(dir)
  return dir
}

function setupOntologyWorktree(dir: string) {
  const wopalDir = join(dir, ".wopal")
  mkdirSync(wopalDir, { recursive: true })
  // Ontology worktree marker: .wopal/.git is a FILE
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

  test("returns undefined when .wopal/.git is a directory (regular git repo)", () => {
    const dir = makeTmpdir()
    const wopalDir = join(dir, ".wopal")
    mkdirSync(join(wopalDir, ".git"), { recursive: true })
    expect(detectWopalSpace(dir)).toBeUndefined()
  })

  test("returns undefined when no .wopal directory exists", () => {
    const dir = makeTmpdir()
    expect(detectWopalSpace(dir)).toBeUndefined()
  })

  test("returns undefined at filesystem root", () => {
    expect(detectWopalSpace("/")).toBeUndefined()
  })

  test("walks up from nested subdirectory", () => {
    const dir = makeTmpdir()
    setupOntologyWorktree(dir)
    const nested = join(dir, "projects", "my-app", "src", "components")
    mkdirSync(nested, { recursive: true })
    const result = detectWopalSpace(nested)
    expect(result).toBeDefined()
    expect(result!.root).toBe(dir)
  })
})

describe("branding constants", () => {
  test("BINARY_NAME is ellamaka", () => {
    expect(BINARY_NAME).toBe("ellamaka")
  })

  test("BINARY_TITLE is Ellamaka", () => {
    expect(BINARY_TITLE).toBe("Ellamaka")
  })

  test("VERSION_PREFIX is ellamaka", () => {
    expect(VERSION_PREFIX).toBe("ellamaka")
  })

  test("UI_UPSTREAM_URL is null by default", () => {
    expect(UI_UPSTREAM_URL).toBeNull()
  })
})

describe("logo", () => {
  test("left and right glyph arrays have the same number of rows", () => {
    expect(ellamaka.left.length).toBe(ellamaka.right.length)
    expect(ellamaka.left.length).toBeGreaterThan(0)
  })

  test("left rows have consistent width and right rows have consistent width", () => {
    const leftWidth = ellamaka.left[0].length
    const rightWidth = ellamaka.right[0].length
    for (let i = 0; i < ellamaka.left.length; i++) {
      expect(ellamaka.left[i].length).toBe(leftWidth)
      expect(ellamaka.right[i].length).toBe(rightWidth)
    }
  })

  test("wordmark combines left + space + right per row", () => {
    expect(wordmark.length).toBe(ellamaka.left.length)
    for (let i = 0; i < wordmark.length; i++) {
      expect(wordmark[i]).toBe(ellamaka.left[i] + " " + ellamaka.right[i])
    }
  })
})
