# 测试隔离规范（Test Isolation）

本文件解释「为什么」和「怎么判」。**规则本身在根 `AGENTS.md` 的 Testing 小节**（全仓不可违反的铁律），
机器可判定的部分在 `packages/opencode/script/test-isolation/`（`bun run check:test-isolation`）。
三处不重复同一句话：规范写 AGENTS，原理写本文，机器规则写 checker。

## 背景：为什么需要这份规范

过去半年 Ellamaka 的测试稳定性问题反复出现，我们用多个独立 Plan 反复修复，每次仍然复发。
原因不是某一行代码写错，而是**测试的运行环境是进程级的，而测试的假设是文件级的**。

一个 Bun 测试进程里，所有测试文件共享同一份 `process.env`、同一份模块注册表、同一份文件系统路径、
同一批 Effect 单例与缓存。任何一处修改如果不在本文件结束时还原，污染就会流向之后加载的所有文件。

最典型的形态是「本地绿、CI 红」：文件加载顺序在不同机器上不同，污染源恰好在受害者之前或之后。
CI 上 runner 的文件顺序是稳定的，所以 CI 每次都以同样的方式失败，而本地每次都可能侥幸通过。

## 历史事故分类

下表是真实事故复盘，每一条都对应一个已经修过的 bug。设计任何新测试前先对照这张表。

| 类别                     | 事故形态                                                                                                        | 后果                                           |
| ------------------------ | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| A 进程级模块替换污染     | Bun `mock.module` 替换共享模块；`mock.restore()` 不撤销它，且对已 import 的绑定生效                             | 后续文件拿到假的实现，CI 与本地结果不一致      |
| B 进程级环境变量污染     | 测试写 `process.env`；Effect `ConfigProvider` 默认层在首次读取时快照 `process.env` 并缓存在 module 级 Reference | 标志位被永久固化，同进程后续文件全部读到错误值 |
| C 进程级文件系统状态污染 | 多个 fixture 争抢同一个全局配置文件                                                                             | 先写者被后写者整段清空，断言随机失败           |
| D 共享单例 / 进程级缓存  | Effect `ScopedCache` / `memoMap` 缓存跨文件存活；共享的 mock server 残留状态                                    | 上一个用例的残留被下一个用例计入               |
| E 靠 sleep 掩盖竞态      | 固定 `Effect.sleep(N)` 等某个后台任务就绪                                                                       | 慢机器上超时，快机器上白等；永远不可靠         |
| F 断言被削弱换绿灯       | 删掉一条 retention 断言；把观察窗口从 12 秒缩到 1.5 秒                                                          | 测试不再验证它声称验证的行为                   |
| G 分层与预算失守         | 真实子进程 / fs watch / git / 网络测试混进 unit 层                                                              | unit 层超时、随机失败                          |
| H 规则无门禁             | 规则只写在文档里                                                                                                | 几个月后同样的违规再次进入仓库                 |

A-H 里的每一类都曾单独修过，又复发。区别在于：A-G 修的是**这一次的具体代码**，
H 才是**为什么会复发**。本规范与 `check:test-isolation` 针对的是 H。

## 三种隔离模型与选择规则

看到一个测试要替换外部依赖时，按下面的顺序选，前面的优先。

### 1. 依赖注入（默认）

把依赖做成可注入的接缝，生产提供真实实现，测试注入替身。

这是唯一在**同进程内**真正可靠的模型：替身的作用域就是那个 Effect layer 或那个测试文件，
不依赖还原，也不依赖加载顺序。

仓库里的现成例子：

- `Layer.mock(Service, { ... })` — 覆盖一个 service 的部分方法，其余方法抛 `UnimplementedError`。
  未被覆盖的方法如果被误调用会直接炸掉，这正是我们想要的信号。
- `MCP.ClientFactoryService` — 引擎通过它创建 MCP client 与 transport；默认实现是真实 SDK。
  `packages/opencode/test/mcp/` 下的测试注入自己的 client / transport 替身。

**什么时候用**：替身要替换的是「任何一个其他测试也可能用到」的东西——模块、单例、共享服务、
网络出口、文件系统路径。

**代价**：产品侧要加一个接缝。这是应该付的成本：接缝一旦存在，以后所有测试都受益。

### 2. 进程内修改后还原

只对**改完能真正恢复原值**的东西用：

- `spyOn(obj, "method")`（Bun 的 `mock.restore()` 对 spy 有效）
- 少数几个 `process.env` 键，且**读取发生在调用时**而不是 import 时
- fake timers
- 每个测试独占 tmpdir 里的文件
- 某个明确拥有的 `globalThis` 测试槽位

**什么时候用**：替身只服务于本文件，且还原是可靠的。

**关键限制**：**读缓存的库不能靠改环境变量**。Effect 的 `ConfigProvider` 默认层在首次读取时
快照 `process.env` 并缓存在 module 级 Reference 上——改 `process.env` 对它无效，
而 `mock.restore()` 也不会撤销这个快照。要让环境变量按调用时读取，
必须显式提供一个每次新建的 provider（见 `src/server/server.ts` 的做法）。

**禁止**：每个文件自己手写一套 `try/finally` 还原。还原逻辑必须收敛到一个共享 helper，
否则一定会有人写错、忘记 await、或者在异常路径上漏掉。

### 3. 独立进程

有些事情在同进程内根本做不到，必须换进程：

- 测试 `mock.module` 本身、或者 module loader
- 模块在 **import 时**就读取 env / config
- process preload / bootstrap
- `process.exit`、signal handler、`process.chdir`
- 无法加 DI 接缝的第三方模块替换
- 同一个 preload 需要两套互相冲突的全局定义

**怎么选**：优先问「能不能改成 DI」。只有当 import 时行为、module loader 这类场景才用独立进程。

仓库里已有的例子：`packages/ellamaka-desktop/electron-mock.ts` 是**固定的 process preload**，
它本身可以继续存在；但某个 Desktop 测试如果想把 electron 换成另一套 mock，就不能在同一个测试进程里做。

## 规则与门禁的对应

| 规则                                   | 门禁    | 判定方式                                                        |
| -------------------------------------- | ------- | --------------------------------------------------------------- |
| 普通测试不出现 `mock.module`           | TISO001 | AST 扫描，命中 baseline 外的记录即失败                          |
| 环境变量变更必须走 scoped helper       | TISO002 | AST 扫描 `process.env.X = ...` / `delete process.env.X`         |
| 不用固定 sleep 当同步                  | TISO003 | AST 扫描 `Effect.sleep(` / `Bun.sleep(` / `setTimeout` 作为等待 |
| unit 层不含真实 I/O                    | TISO004 | 扫描 unit 层文件里的 subprocess / fs.watch / 网络调用           |
| 不新增 skip/todo，禁用 .only           | TISO005 | AST 扫描 `.only` 与新增的 `.skip` / `.todo`                     |
| 共享路径必须走 ownership-aware fixture | TISO006 | 扫描直接写 `Global.Path.*`、固定 `/tmp` 路径                    |
| baseline 不得有 stale 条目             | TISO007 | baseline 里记录的违规在源码中已不存在即失败                     |
| 测试不得污染进程环境                   | TISO101 | 运行时哨兵：preload 记录 env/cwd 基线，测试结束后比对           |

**baseline 的维护规则**：baseline 是**精确债务清单**，每条记录「规则 + 文件 + 具体目标（模块 id / env key / API）+ 出现次数」。
出现次数是必需的：同一个文件里第二条完全相同的违规如果没有计数，就会匹配上只记录了一次的条目而被漏掉。

- 新违规不在 baseline 里 → CI 失败。
- 同一目标比 baseline 记的次数更多 → 多出来的算新违规，CI 失败。
- 旧违规减少或消失 → 多余次数变成 stale，CI 失败，必须同步扣除，不能留给后续违规使用。
- **baseline 只能逐个目标缩小，不能扩大。** `--fix` 逐条比较目标与次数；即使总数下降，只要出现新目标或某个目标次数增加，也拒绝写入。

没有自动接纳新违规的开关。历史存量清单不是合格证明；静态规则也不能证明不存在运行时竞态。

**integration 边界不是手写白名单**：`INTEGRATION_ROOTS` / `INTEGRATION_FILES` 的内容必须与真实 runner 配置一致
（`packages/opencode/script/run-tests.ts` 的 `INTEGRATION_DIRS`、各包 `package.json` 的 `test:integration`）。
`packages/opencode/script/test-isolation/policy.test.ts` 每次跑门禁都会比对，任何一边改了另一边没跟上就会失败。
这样「某个包的整个 `test/` 目录被当成 integration 而整片豁免检查」这类弱化不会悄悄发生。

固定 process preload（例如 `electron-mock.ts`）不进 baseline，单独登记为合法架构例外。
故意含违规的扫描器样本也必须精确登记到文件，不能因为目录叫 `fixture` 就整体豁免。

## 故障模拟与稳定性验证

- **故障由测试明确控制。** 验证拒绝写入时，在文件系统 service 或可恢复的写入 spy 上注入 `EACCES`，保留真实调用链；不要仅靠 `chmod 0444` 假定会拒绝写入。root、Windows ACL 与挂载策略会改变结果。权限位本身是被测对象时，单独验证权限位，并明确执行身份与平台前提。
- **先证明走到了目标错误路径。** 不只断言“失败了”，还检查具体错误和原数据未被修改，防止因别的异常碰巧通过。spy 用 `using` 恢复；Effect 依赖用 scoped layer/service 注入。
- **门禁与实际操作同址。** 测试若先探测环境（能否写入、挂载是否就绪、路径是否在沙箱允许根内）再选择分支，真实写入必须发生在被探测的同一个目录或资源上。`~/tmp` 这类可能指向别的卷甚至未挂载位置的软链，会让门禁和实际操作看到两个不同的文件系统。沙箱拒绝探针规范化后必须位于所有允许写入根之外；若原路径不满足，选用符合前提的目标，不能把拒绝断言改成仅检查“没有错误”。成功路径必须验证输出或最终状态；路径错误、权限错误和只读挂载必须明确区分，不得吞掉意外错误。
- **环境必须恢复原值。** `opencode`、`ellamaka-core`、`ellamaka-cordis` 都使用各自 `test/fixture/process-env.ts` 的 `scopedEnv`；其他 package 需要修改环境变量时，先补同样的 package-local helper。值不存在和空字符串要分别恢复。禁止并发测试共享这些进程级变更；import 时读取或带缓存的依赖用 DI / 独立进程。
- **资源先停止再清理。** 在 `finally` / async disposal 中等待容器、watcher、server 和子进程结束，再删除各自的临时目录。断言失败也必须走同一清理路径。
- **偶发失败不能用一次绿灯关闭。** 先保留原命令、提交、失败信息，区分单文件与组合、冷进程与复用缓存、不同文件顺序。建立能触发原缺陷的回归用例；验证组中任一次失败都判失败，不能挑选成功结果。
- **分层不减少覆盖。** 调整 unit/integration 执行入口时，要核对改动前后实际执行的文件；移出的用例必须在对应 CI 层执行，不能通过少跑测试获得绿灯。当前 OpenCode `test:ci` 仍保留完整扫描。
- **失败信息必须够定位。** 工具失败断言附带结构化错误的消息、类型、错误码和内容；需要底层证据时，必须确认探针实际命中了调用链，不能只装一个未被调用的 spy。测试 fixture 不含真实凭证。缓存、权限、子进程和网络等环境前提必须显式验证，不能依赖开发机已有状态。
- **跨运行时进程边界要验证底层契约。** 不只断言命令成功退出，还验证 stdin/stdout/stderr 的继承语义、超过管道容量的完整输出、取消和退出后的资源回收。Bun bootstrap 的 `execve` 回归直接检查目标 fd 标志，并验证 256 KiB 输出；这样管道背压问题可以确定复现，不依赖 CI 调度碰巧触发。文件名出现在 I/O 错误中也不能直接判定为读文件失败，必须沿真实系统调用路径确认。

## 断言强度

有些规则机器只能拦一部分。`.only`、新增 `.skip`、新增 `.todo` 可以自动拦；
但「删掉一条 `expect` 是不是在削弱行为？」机器很难可靠回答。

不要做一个「expect 行数不能减少」的门禁——误报会多到没人看。这条继续由实施评审负责：

- 删除或改弱断言
- 缩短观察窗口
- 用 retry / reconnect 把真实 bug 隐掉

未来若开启 PR CI，可以做一个**提示型** diff checker：发现删除 expect、降低 timeout、
增加 retry 时标记「test strength review required」，但**不自动判失败**。

## 门禁怎么跑

```bash
bun run check:test-isolation                         # 仓库根，静态检查 + baseline 校验
bun run check:test-isolation -- --fix                 # 逐条扣除已修复的违规（禁止接纳新违规）
```

任何改动测试、fixture、preload 或测试配置文件的提交，都必须在本地跑过这个命令。

## 分期

- **P0（本次落地）**：铁律写进根 AGENTS.md；仓库级 `check:test-isolation`；
  TISO001-TISO007 静态门禁（含计数 baseline、stale 检测、边界漂移守护）；现有 App 顺序隔离检查接入 CI。
  规则补全后一次性看见的历史存量（31 个 unit 层 live-I/O 测试）已如实记入 baseline，属于 P1 迁移对象。
- **P1**：把已记入 baseline 的 unit 层 live-I/O 测试迁到 integration 层（或改造为 DI）；
  继续用 package-local `scopedEnv` helper 清理 baseline 中剩余的手写环境变量恢复逻辑；
  preload 加 env/cwd 运行时哨兵（TISO101）；存量 `mock.module` 逐步迁到 DI；
  顺序回归泛化到全仓高风险分组。
- **P2**：singleton / 共享 fixture 的自动 reset 检测；随机 seed 顺序回归；
  提示型断言强度 diff checker；listener / handle / 资源泄漏哨兵。

## 长期目标

用两个可以量化的数字衡量进展：

1. 普通测试中的 `mock.module` = 0
2. 未通过 scoped fixture 的进程级全局变更 = 0

这两个数字比「所有测试都要隔离」这种抽象规则更容易执行，也最直接覆盖过去半年反复踩的坑。
