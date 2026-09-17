// cli/version-line.ts — thin CLI entry: parse argv → call library → exit code.
// Usage:
//   version-line.ts <bump> <stable?> <candidate?> [explicit] [withdrawn-json]
//   bump       = rc|beta|stable|minor|major
//   stable     = 该产品已发布最高 stable (X.Y.Z)；空串表示从未发布
//   candidate  = 该产品通道最高 prerelease (X.Y.Z-rc.N / X.Y.Z-beta.N)；空串表示无
//   explicit   = 显式指定目标版本（可选），绕过 bump 自动推断、只做单调校验
//   withdrawn-json = 该产品永久作废版本数组 JSON（可选，自动推断时连续跳过）

import { inferNextVersion } from "../version-line"

const [bump, stable, candidate, explicit, withdrawnJson] = process.argv.slice(2)

if (!bump) {
  console.error(
    "usage: version-line.ts <rc|beta|stable|minor|major> <stable?> <candidate?> [explicit-version] [withdrawn-json]",
  )
  process.exit(2)
}

const valid = ["rc", "beta", "stable", "minor", "major"] as const
if (!(valid as readonly string[]).includes(bump)) {
  console.error(`无效 bump 类型: ${bump} (期望 rc|beta|stable|minor|major)`)
  process.exit(2)
}

let withdrawn: string[] = []
if (withdrawnJson) {
  try {
    const parsed: unknown = JSON.parse(withdrawnJson)
    if (Array.isArray(parsed) && parsed.every((v) => typeof v === "string")) {
      withdrawn = parsed
    }
  } catch {
    // 非法枚举输入视为未提供清单，由调用方在校验层兜底。
  }
}

try {
  process.stdout.write(
    inferNextVersion(
      { stable: stable || undefined, candidate: candidate || undefined },
      bump as (typeof valid)[number],
      explicit || undefined,
      withdrawn,
    ),
  )
} catch (err) {
  console.error((err as Error).message)
  process.exit(1)
}
