import ts from "typescript"

/** Remove redundant union members emitted by the OpenAPI generator. */
export function normalizeGeneratedUnions(input: string): string {
  let source = input
  for (;;) {
    const file = ts.createSourceFile("generated.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const edits: Array<{ start: number; end: number; text: string }> = []
    const visit = (node: ts.Node) => {
      if (ts.isUnionTypeNode(node)) {
        const members: ts.TypeNode[] = []
        const flatten = (type: ts.TypeNode) => {
          if (ts.isParenthesizedTypeNode(type) && ts.isUnionTypeNode(type.type)) {
            type.type.types.forEach(flatten)
          } else if (ts.isUnionTypeNode(type)) {
            type.types.forEach(flatten)
          } else members.push(type)
        }
        node.types.forEach(flatten)
        const kinds = new Set(members.map((member) => member.kind))
        const seen = new Set<string>()
        const filtered = members.filter((member) => {
          const text = member.getText(file)
          if (seen.has(text)) return false
          seen.add(text)
          if (kinds.has(ts.SyntaxKind.AnyKeyword)) return member.kind === ts.SyntaxKind.AnyKeyword
          if (kinds.has(ts.SyntaxKind.UnknownKeyword)) return member.kind === ts.SyntaxKind.UnknownKeyword
          if (member.kind === ts.SyntaxKind.NeverKeyword) return false
          if (ts.isLiteralTypeNode(member)) {
            const literal = member.literal
            if (ts.isStringLiteral(literal) && kinds.has(ts.SyntaxKind.StringKeyword)) return false
            if (ts.isNumericLiteral(literal) && kinds.has(ts.SyntaxKind.NumberKeyword)) return false
            if (
              (literal.kind === ts.SyntaxKind.TrueKeyword || literal.kind === ts.SyntaxKind.FalseKeyword) &&
              kinds.has(ts.SyntaxKind.BooleanKeyword)
            )
              return false
          }
          return true
        })
        if (filtered.length > 0 && filtered.length < members.length) {
          edits.push({
            start: node.getStart(file),
            end: node.getEnd(),
            text: filtered.map((item) => item.getText(file)).join(" | "),
          })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
    if (!edits.length) return source
    edits.sort((a, b) => a.start - b.start || b.end - a.end)
    const disjoint: typeof edits = []
    for (const edit of edits) {
      if (disjoint.length && edit.start < disjoint[disjoint.length - 1].end) continue
      disjoint.push(edit)
    }
    for (const edit of disjoint.reverse()) source = source.slice(0, edit.start) + edit.text + source.slice(edit.end)
  }
}
