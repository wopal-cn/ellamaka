---
name: Ellamaka Documentation AGENT RULES
description: Ellamaka 设计文档与 Plan 评审辅助文件的长期维护规则
---

# Agent Development Rules

## Canonical References

- [项目规范](../AGENTS.md)
- [DESIGN 索引](./DESIGN.md)
- 文档约定（头部字段、标题与引用、目标态写法）由 `dev-doc-master` 技能拥有；照它执行，不要在此复述格式。

## Architecture and Directories

docs 目录包含主 DESIGN、其索引的子设计，以及 GAPS 等临时评审材料。DESIGN.md 是完整文档索引和详细架构的唯一来源。

AGENTS 可以保留帮助实施者找到正确模块的精简、稳定归属图；不能复制 DESIGN 的详细契约，也不能把临时 Plan 范围写成长期事实。

## Development Commands

| Scenario | Command | When |
|---|---|---|
| DESIGN 一致性检查 | python3 ../../../.wopal/skills/dev-doc-master/scripts/verify-docset.py . --main DESIGN.md | 修改文档集后 |

## Implementation Rules

- 在拥有该决策的 DESIGN 中更新内容，并检查受影响的父级/兄弟链接是否矛盾。
- DESIGN 写目标态；进度和实现任务归 Plan。Draft/Proposed 不构成已确定实现目标。
- 核对覆盖时把 Active 目标与真实调用链、配置对照；不确定性明确记录，不用抽样代替完整检查。
- GAPS 是临时评审/Plan 辅助：写当前差距、变更类型和代表代码入口。保留 task 引用，直到评审确认每个 gap 都有 Plan task；之后由用户删除 GAPS。
- GAPS 按模块组织且让人易读；不写成实施步骤，也不借此扩张推测性架构。
- 保留历史研究/archive；当前结论进入 Active DESIGN，一次性审计证据放隔离临时产物。
- 用户明确指定的文档格式和生命周期优先于通用模板；单独核对其要求。
- 主/子设计使用相对链接，改后检查文件路径和章节锚点。

## Testing

- 修改设计文档集后运行可用的 docset 检查。用户指定的 GAPS 格式若不受通用检查器支持，需单独检查完整性和链接并说明限制。

## User-Supplied Rules

（无）
