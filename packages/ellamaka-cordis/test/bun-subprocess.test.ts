import { describe, expect, test } from "bun:test"
import { rewriteSubprocessUtilImport } from "../src/runtime/bun-subprocess"

const OFFICIAL =
  'import { getSystemErrorMessage, getSystemErrorName, inspect } from "node:util";\n' +
  "const detail = getSystemErrorMessage(uvError);"

describe("Bun subprocess compatibility", () => {
  test("replaces the Node-only named import with an equivalent local helper", () => {
    const rewritten = rewriteSubprocessUtilImport(OFFICIAL)
    expect(rewritten).toContain('import { getSystemErrorName, inspect } from "node:util";')
    expect(rewritten).toContain("const getSystemErrorMessage = (code) => getSystemErrorName(code);")
    expect(rewritten).toContain("const detail = getSystemErrorMessage(uvError);")
    expect(rewritten).not.toContain("import { getSystemErrorMessage")
  })

  test("fails loudly when the upstream import seam changes", () => {
    expect(() => rewriteSubprocessUtilImport('import { inspect } from "node:util";')).toThrow("util import changed")
    expect(() =>
      rewriteSubprocessUtilImport(
        'import { getSystemErrorMessage, getSystemErrorName, inspect } from "node:util";\n' +
          'import { getSystemErrorMessage, getSystemErrorName, inspect } from "node:util";',
      ),
    ).toThrow("util import changed")
  })
})
