# WopalSpace Ontology Synchronization

> **Status**: Active
> **Updated**: 2026-10-29
> **Parent**: `./DESIGN.md`
> **Scope**: private `@wopal/wopalspace` 的 Ontology source-chain 状态模型、同步事务、history reconciliation、状态输出与正式 Git 历史合同
> **Sibling DESIGNs**:
>
> - `./DESIGN-wopalspace.md` — WopalSpace application 领域、operation 与状态归属
> - `./DESIGN-ellamaka-sdk.md` — Public Platform contract、HTTP 与 trusted-local transport

## Purpose

Ontology repository 同时承载共享能力内容与 Git 协作历史。`local main` 可以通过贡献分支把内容送到 upstream；GitHub merge、squash 与 rebase 都可能让 upstream 得到新的 commit identity。此时文件 tree 可以已经一致，而 commit ancestry 仍然分叉。

同步必须同时回答两个独立问题：

- **Content**：把 source 合入 target 后，target 的文件 tree 是否改变。
- **History**：source 当前 commit 是否已经进入 target ancestry，后续 Git 比较能否把它作为已消费基线。

tree 一致只代表内容对齐。source commit 尚未进入 local ancestry 时，`ontology.sync` 仍需要完成 history reconciliation。这个 reconciliation 让后续 `merge-base`、three-dot diff、贡献差量和 cleanup gate 拥有稳定基线，同时不得制造与 source-chain 无关的过程提交。

## Source Chain

Fork 模式包含三个长期 ref：

```text
upstream/main   central ontology source
      │
      │ history/content intake
      ▼
local main      local capability pool and contribution source
      │
      │ ordinary fast-forward push after local transaction succeeds
      ▼
origin/main     user's fork mirror
```

`origin/main` 也可能被另一台机器推进，因此 apply 的实际本地顺序固定为：

```text
origin/main -> local candidate
upstream/main -> local candidate
local candidate -> local main
local main -> origin/main
```

Clone 模式只有：

```text
origin/main -> local main
```

`contribute/*` branch 与其 worktree 不属于这条 main source-chain。它们由原生 Git/GitHub contribution workflow 维护；sync 只处理 `main` refs，不删除贡献资源。

## Synchronization Invariants

一次完整 Fork sync 成功后必须同时满足：

1. `upstream/main` 是 `local main` 的 ancestor。
2. `origin/main` 与 `local main` 指向同一 commit。
3. local-only 内容与提交仍保留在 `local main`。
4. `local main` 的 first-parent 链保持本地演进顺序；remote source 作为 merge commit 的后续 parent 接入。
5. 后续相同 refs 的重复 sync 不创建新 commit。

一次完整 Clone sync 成功后必须满足 `origin/main` 是 `local main` 的 ancestor，同时保留 local-only 内容。

这些 invariant 使用普通 Git ancestry 表达，不额外建立 sync ledger、数据库或隐藏状态文件。Git repository 继续是内容与 source-chain 历史的唯一真相源。

## State Model

### History State

每个 directional segment 都以 `fromBranch` 为 source、`toBranch` 为 target，返回以下 history state：

| `historyState` | 含义 |
| --- | --- |
| `same` | 两个 ref 指向同一 commit |
| `source-ancestor` | source 已经进入 target ancestry；target 无需消费 source history |
| `target-ancestor` | target 落后于 source；可以通过 fast-forward 吸收 source history |
| `diverged` | 双方有共同祖先且各自存在独有 commit |
| `no-common-base` | 两个可解析 ref 没有共同祖先 |
| `unavailable` | 必需 ref 无法解析，不能建立可靠关系 |

当共同祖先可用时，同时返回 `sourceAhead` 与 `targetAhead` commit 数；不可可靠计算时两者为 `null`。commit 数只说明 history shape，不直接等价于待同步文件数或待贡献内容。

### Content State

`contentState` 描述当前 segment 在既定 source/target 关系下的内容事实；不同 `kind` 使用各自与动作一致的计算方式。

merge 型 segment 使用 quarantined `merge-tree` 预测 source 合入 target 的结果：

| `contentState` | 含义 |
| --- | --- |
| `aligned` | merge result tree 与 target 当前 tree 相同 |
| `changes` | merge result tree 会改变 target tree；`fileDiffs` 列出实际变化 |
| `conflict` | merge 无法干净完成；`conflictFiles` 列出冲突文件 |
| `unknown` | 缺 ref、无共同祖先或无法可靠预测 |

`aligned` 不表示 history 已闭合。`historyState=diverged` 且 `contentState=aligned` 正是 squash/rebase 后最常见的 reconciliation 状态。

push 型 segment 在 refs 可可靠比较时直接比较 source/target tree：tree 相同为 `aligned`，不同为 `changes`，`fileDiffs` 表示这次 mirror push 的 tree 差量；push 不产生 merge conflict，因此 `conflictFiles=[]`。`historyState=no-common-base|unavailable` 时返回 `contentState=unknown`、`fileDiffs=[]`、`conflictFiles=[]`，由 action 决定是否可以继续。

contribute 型 segment 只有在 `upstream/main` 已是 `local main` ancestor 时拥有权威 content baseline。此时以 upstream 为 merge base 计算 three-dot diff：无差异为 `aligned`，有差异为 `changes` 并返回待贡献 `fileDiffs`。baseline 尚未闭合时返回 `contentState=unknown`、`fileDiffs=[]`、`conflictFiles=[]`；它不提前猜测待贡献内容。

### Required Action

公开状态使用明确动作代替单一 `upToDate` 判断：

```ts
type OntologyHistoryState =
  | "same"
  | "source-ancestor"
  | "target-ancestor"
  | "diverged"
  | "no-common-base"
  | "unavailable"

type OntologyContentState = "aligned" | "changes" | "conflict" | "unknown"

type OntologyFlowAction =
  | "none"
  | "fast-forward"
  | "merge-content"
  | "reconcile-history"
  | "push"
  | "contribute"
  | "sync-first"
  | "blocked"

interface OntologyFlowAnalysis {
  label: string
  fromBranch: string
  toBranch: string
  kind: "merge" | "push" | "contribute"
  historyState: OntologyHistoryState
  sourceAhead: number | null
  targetAhead: number | null
  contentState: OntologyContentState
  fileDiffs: readonly FileDiff[]
  conflictFiles: readonly string[]
  requiredAction: OntologyFlowAction
}
```

merge 型 segment 的动作判定固定为：

| History | Content | `requiredAction` |
| --- | --- | --- |
| `same` / `source-ancestor` | `aligned` | `none` |
| `target-ancestor` | `aligned` / `changes` | `fast-forward` |
| `diverged` | `aligned` | `reconcile-history` |
| `diverged` | `changes` | `merge-content` |
| `diverged` | `conflict` | `blocked` |
| `no-common-base` / `unavailable` | `unknown` | `blocked` |

这个表同时驱动 preview 与 apply，不允许 status 以 tree equality 把 `reconcile-history` 折叠成 `none`。push 与 contribute 的动作判定由 Inspect Contract 中对应 segment 规则定义。

## Inspect Contract

`ontology.inspect` 只读取本地 refs 与 object database。`ontology.refresh` 负责 fetch remote refs 后返回同一 inspection model；HTTP 与 local transport 使用同一 DTO。

Fork 模式固定报告四个关系：

| Segment | `kind` | 目的 |
| --- | --- | --- |
| `origin/main -> local main` | `merge` | 判断另一台机器或 fork main 的历史/内容是否需要先进入 local |
| `upstream/main -> local main` | `merge` | 判断中央 source 是否需要 content merge 或 history reconciliation |
| `local main -> origin/main` | `push` | 判断 fork mirror 是否需要普通 push，或是否必须先消费 remote history |
| `local main -> upstream/main` | `contribute` | 判断当前 local main 是否存在仍可贡献的内容 |

Clone 模式只报告 `origin/main -> local main` merge segment；它没有 fork mirror 或 upstream contribution segment。

### Push State

`local main -> origin/main` 使用 ancestry 判断是否可普通 push：

- origin 与 local 相同：`contentState=aligned`，`requiredAction=none`。
- origin 是 local ancestor：按两个 tree 返回 `aligned|changes`，`requiredAction=push`；即使 tree 已相同，也通过普通 push 闭合 mirror history。
- local 是 origin ancestor，或双方 diverged：按两个 tree 返回 `aligned|changes`，`requiredAction=sync-first`；先运行 origin intake stage，禁止 force push。
- 无共同祖先或 ref 不可用：`contentState=unknown`、空 `fileDiffs/conflictFiles`，`requiredAction=blocked`。

### Contribution State

`local main -> upstream/main` 只在 `upstream/main` 已经是 `local main` ancestor 时计算权威待贡献内容。此时 three-dot diff 的 merge base 就是当前 upstream baseline，`fileDiffs` 只表示 baseline 之后仍留在 local 的内容：

- 有文件差异：`contentState=changes`，`requiredAction=contribute`。
- tree 无差异：`contentState=aligned`，`requiredAction=none`。

`upstream/main` 可解析但尚不是 `local main` ancestor 时，贡献 segment 返回 `contentState=unknown`、空 `fileDiffs/conflictFiles` 与 `requiredAction=sync-first`，不把 commit divergence 或 three-dot 结果冒充为待贡献文件清单。无共同祖先或 ref 不可用时返回同样的 unknown content facts，但 `requiredAction=blocked`。这样 squash/rebase 已落地的内容不会在 reconciliation 之前被重复展示为新贡献。

CLI 或其他 presentation 可以展示更自然的文本，但不得丢失 content/history 两个维度。`Content: aligned` 与 `History: reconciliation required` 是合法且常见的组合。

## Sync Transaction

### Preview

preview 使用当前可见 refs，在 quarantined object store 中完成 virtual merge 与必要的 virtual commit projection。它不得改变：

- local/remote-tracking refs；
- index 与 worktree；
- `FETCH_HEAD`；
- repository object database；
- contribution branch/worktree；
- remote repository。

preview 按 apply 的真实 stage 顺序投影，因此第二个 stage 必须基于第一个 stage 的 projected commit，而不是再次以原始 `main` 独立判断。

### Apply

apply 在第一处持久写入前重新验证 registry、repository identity、dirty state 与 in-progress Git operation，并刷新所需 remote refs。

Fork 模式在一个隔离 candidate transaction 中执行：

1. 从当前 `local main` 建立 candidate。
2. 对 `origin/main` 执行 merge decision。
3. 在步骤 2 的结果上对 `upstream/main` 执行 merge decision。
4. 任一步骤 conflict / blocked 时放弃 candidate；`local main` 保持原 commit。
5. 两个本地 stage 都成功后，一次性把 `local main` 推进到 candidate HEAD。
6. 以普通 push 把 `local main` 发布到 `origin/main`。

Clone 模式只执行 origin stage；host repository 当前检出其他 branch 时，同样通过隔离 candidate 推进 `main`，不切换宿主工作区。

apply 不使用 reset、force push 或 history rewrite 来“整理”现有 refs。remote 在 fetch 后并发变化导致 push 被拒时，本地阶段保持成功，remote 阶段返回失败；下一次 sync 重新 fetch 并只补齐新的 remote 差异。

## Merge Decisions

对每个 merge stage：

1. source 已经是 target ancestor：skip。
2. target 是 source ancestor：fast-forward；不创建 merge commit。
3. 双方 diverged：执行 virtual merge。
4. virtual merge conflict：整个 local transaction 失败，不推进 `main`。
5. virtual merge clean 且 result tree 改变：创建 content merge。
6. virtual merge clean 且 result tree 与 first parent 相同：创建 history reconciliation merge。

history reconciliation merge 的意义是把 source commit 纳入 local ancestry，而不是重复写文件。它是 squash/rebase contribution 回流后的正式 source-chain checkpoint。

## Formal Git History

正式 Ontology history 使用以下规则保持短、稳定、可读：

- skip 不创建 commit。
- fast-forward 只移动 ref，不创建 commit。
- 普通 push 不创建 local commit。
- 每个 diverged source stage 最多创建一条 merge commit。
- first parent 始终是当前 local/candidate history；source remote-tracking ref 是后续 parent。
- sync 不创建单独的 lifecycle、receipt 或“同步完成”记录 commit。
- candidate worktree 名、临时 branch 名、PID、UUID 不进入 commit subject/body。

content merge 使用固定 subject：

```text
sync(ontology): integrate origin/main
sync(ontology): integrate upstream/main
```

tree 不变的 reconciliation merge 使用固定 subject：

```text
sync(ontology): reconcile origin/main history
sync(ontology): reconcile upstream/main history
```

Git parent 本身已经记录被接入的 source commit identity，因此 subject 不重复拼接 SHA、时间戳或随机标识。连续重复 sync 在 refs 未变化时产生零 commit。

origin 与 upstream 保持独立 stage。二者代表不同远端事实、冲突来源和 retry 边界；不以 octopus merge 或 synthetic multi-parent record 把两个 stage 合成一条难以解释的提交。

## Sync Result Contract

preview 与 apply 返回同一 step vocabulary：

```ts
type OntologySyncAction =
  | "skipped"
  | "fast-forwarded"
  | "merged"
  | "reconciled"
  | "pushed"
  | "conflict"
  | "failed"

interface OntologySyncStep {
  step: string
  action: OntologySyncAction
  fileDiffs?: readonly FileDiff[]
  conflictFiles?: readonly string[]
  summary?: string
}
```

语义固定为：

- `fast-forwarded`：吸收 source history，无新 merge commit。
- `merged`：产生 content-changing merge commit。
- `reconciled`：产生 tree-preserving history reconciliation merge commit，`fileDiffs=[]`。
- `pushed`：remote mirror 更新成功。
- `conflict`：当前 local transaction 未提交。
- `failed`：非 merge-conflict 的 stage 失败；结果同时说明已经成功的 earlier stage 是否持久化。

用户界面不得把 `reconciled` 渲染成“0 files merged”这种内容操作。它应明确表示“内容已一致，历史基线已闭合”。

## Squash and Rebase Closure

当 contribution 在 upstream 以 squash 或 rebase 形式落地时，upstream commit 与 local 原提交没有 ancestry 关系，即使贡献内容已经完全相同：

```text
local main:    A -- L1 -- L2 -- X
               \
upstream/main:  `------ U
```

`U` 可以承载 `L1/L2` 的等价内容，`X` 是仍留在 local 的其他工作。此时把 `U` merge 到 local 的 result tree 可以与 local tree 完全一致，但 `U` 仍不是 local ancestor。

`ontology.sync` 创建一条 reconciliation merge 后：

```text
local main:    A -- L1 -- L2 -- X -- R
               \                 /
upstream/main:  `------ U -------'
```

`R` 不改变 first-parent tree，但建立 `U -> R` ancestry。此后 `git diff upstream/main...main` 的 baseline 是 `U`，只剩 `X` 等真正尚未进入 upstream 的 local 内容。贡献 workflow 的 merged-PR cleanup 也可以用 upstream landing commit 已进入 local ancestry 作为可验证事实。

因此 tree equality 只能证明内容已回流，不能替代 reconciliation；反过来，reconciliation 也不代表所有 local 内容都已贡献，剩余 local-only 内容仍由 contribution analysis 展示。

## Failure and Retry

- required remote/ref 缺失：`blocked`，不把无法解析误报为 up to date。
- fetch 失败：apply 在本地 Git 写入前失败；inspect 可以继续展示缓存 facts，并标记 refresh 失败。
- dirty host repository 或 in-progress merge/rebase/cherry-pick/revert：apply 在创建持久结果前拒绝。
- origin stage 成功、upstream stage conflict：candidate 整体丢弃，`local main` 与 remote 均保持原状。
- local transaction 成功、origin push 失败：local result 保留并明确返回 partial success；retry 重新 fetch，已进入 local ancestry 的 source stage 会自然 skip，只重试仍需完成的 remote half。
- push 因 origin 并发推进而拒绝：不 force；下一次 sync 把新的 origin history 先纳入 local，再重新 push。
- cleanup failure 只影响 sync 自己创建的 candidate resources；不得删除或修改 contribution worktree/branch。

## Invariants

1. Content alignment 与 history alignment 是两个独立事实；公开状态同时表达两者。
2. Fork sync 的完整成功条件是 `upstream/main` 为 `local main` ancestor 且 `origin/main == local main`。
3. Squash/rebase 后 tree 相同但 ancestry diverged 时，history reconciliation 是必需同步动作。
4. Contribution pending diff 只在 upstream baseline 已进入 local ancestry 后计算并对外宣称权威。
5. Sync 不通过 force push、reset 或 rewrite existing history 达成对齐。
6. Preview 与 inspect 对真实 repository 保持零写入。
7. 每个 diverged source stage 最多产生一条必要 merge/reconciliation commit；其他阶段不写 record commit。
8. 正式 sync commit subject 稳定、可读，不包含临时执行 identity。
9. 任一 conflict 不得留下半完成 local main；remote push failure 与 local success 必须分开报告。
10. Contribution branch/worktree lifecycle 与删除授权不属于 sync。
