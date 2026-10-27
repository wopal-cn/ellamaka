# Plan 2 compatibility baseline

本目录保存迁移输入与旧 owner 的结果证据。Task 1 只冻结基线；新 owner 的等价性由 Task 2–7 在相同输入上验证，不能用静态 JSON 的自我断言代替调用领域实现。

- Ellamaka base: `c2de827fe3ae6741b99756dc4f716f735f6fb397`
- Wopal CLI base: `d90b7a99eeea19c50d9ff895285ba50382948fb3`
- 行为索引与来源：`fixtures/compatibility/matrix.ts`。
- 输入：`assembly-files.json`、`setup-states.json`、`materialization-patterns.json`。
- 真实本地 Git/Home/Space 构造与清理：`git-space.ts`；失败场景输入：`scenarios.ts`。
- 旧 owner 的脱敏输出：`baseline-results.json`。路径、随机目录和无关 commit SHA 不作为业务期望。

## 已执行的旧 owner 基线

以下 CLI 命令在空间的 `projects/wopal-cli/` 执行，使用其已有 Git/environment isolation setup；仅使用本地 fixture。

```sh
pnpm exec vitest run tests/lib/ontology-status.test.ts tests/lib/space-sync.integration.test.ts tests/lib/setup-operations.test.ts
pnpm exec vitest run tests/lib/ontology/sync.test.ts tests/lib/ontology-capability-list.test.ts
pnpm exec vitest run tests/lib/ontology/install.test.ts tests/lib/ontology/clone.test.ts tests/lib/ontology/remotes.test.ts tests/lib/space-reconcile.test.ts tests/lib/space-meta.test.ts tests/lib/space-capability.integration.test.ts tests/lib/space-capability-local.integration.test.ts tests/lib/space-scanner.test.ts
```

结果分别为 130/3 files、41/2 files、275/8 files，全部通过。第三组完整日志在空间 `.wopal-space/.tmp/plan2-migration-baseline.log`。

Ellamaka 旧消费者基线：

- `packages/ellamaka-onboarding/`: `bun run test` → 81 tests / 2 files 通过。
- `packages/ellamaka-app/`: `bun run test:unit --force-exit` → 1280 tests / 161 files 通过。
- `packages/opencode/`: `bun test --timeout 30000 --force-exit test/server/workbench-session-tree.test.ts test/server/workbench-session-api.test.ts test/server/workbench-space-files.test.ts test/server/workbench-session-projection.test.ts test/server/wopal-cli-contract.test.ts` → 46 tests / 5 files 通过。

这些旧测试是迁移依据。Vitest 全局 mock、环境污染和依赖 CLI executable 的消费者机制不迁入新测试。

## 重放与后续比较

包内 unit/integration 与根 targeted runner 自动发现各层测试；默认测试不依赖另一个仓库存在。

新 owner 的 integration 测试调用 `createCompatibilityFixture(parent, mode)`，通过 `prepareSpaceScenario` 构造输入，再调用真实 service，与 golden 的相应领域字段及实际副作用比较。fixture 的 `snapshot()` 包含 refs、index、sparse、meta、registry、工作区文件、Git objects 和 FETCH_HEAD，支持 preview 零写入与失败恢复断言；始终在 finally/disposal 边界清理 fixture。

原始输出由当前空间 `.wopal-space/.tmp/plan2-compatibility-capture.ts` 捕获，脚本显式调用旧 CLI owner 与旧 Onboarding owner，属于一次性证据工具，不进入默认测试入口。需要重新捕获时先核验上述两个 SHA，并在独立子进程中设置隔离 `WOPAL_HOME`，执行 `bun run .wopal-space/.tmp/plan2-compatibility-capture.ts`。重新捕获不是更新期望以通过新 owner 测试的授权；旧基线与 intentional delta 必须分别保留。

## Active DESIGN 已明确的变化

- Ontology inspect 仅查本地 facts；fetch 与贡献 PR 查询移到显式 refresh。贡献创建/修复/清理由原生 Git/GitHub 工作流承担。
- Setup 只保留 Web presentation，不安装产品；completion 重验 application goals，不以 CLI inventory、Core readiness 或 DSH readiness 作为永久门禁。
- 损坏的 Setup state 只读报告，inspect 不再改名或删除文件；single-flight、取消、安全提交边界与失败恢复仍需验证。
- Space 先物化再做 instance preparation；后者失败/取消保留已物化 Space，重试只补 preparation。
- 可复用领域能力进入 public contract；官方 App 跨域投影进入独立 private BFF。
- 旧 Space merge-conflict preview 会写入 Git objects，golden 记录 `changedFields: ["objects"]`。这是旧副作用证据；Task 4 必须按 Active DESIGN 改成 preview 零写入，不能把该副作用固化为新行为。

## 尚待新 owner 证明

Task 2 验证 Ontology 安装、拓扑、只读检查、refresh 分阶段失败、历史/冲突/partial-success/重试；Task 3–4 验证 registry、文件边界、物化、selection/sparse/touch-set 和事务恢复；Task 6 验证 Setup stale plan、secret、安全取消和完成写入；Task 5、7–8 在真实 HTTP/generated client 与无 `wopal` PATH 上验证消费者、认证和制品。Task 1 的 fixture 构造测试本身不代表这些行为已交付。
