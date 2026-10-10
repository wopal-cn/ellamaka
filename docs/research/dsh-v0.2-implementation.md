# DSH v0.2 升级实施记录

## Working Agreement

2026-10-09 用户明确指定：由当前 Agent 亲自实施与指导验证，不走 dev-flow 自动生命周期，不委派。原升级 Plan 只作为范围与验收参考，本文记录实际进展。

- 精确目标：DSH 0.2.0-rc.2。
- Ellamaka：现有 feature/upgrade-dsh-v0.2 分支及升级 worktree。
- Ontology：独立 feature/upgrade-dsh-v0.2 分支，工作树 ontology-feature-upgrade-dsh-v0.2，从 space/wopal-workspace 已提交版本建立，保留同一稀疏装配。
- 验证：用户最新确认 WOPAL_HOME=/Users/sam/.wopal，在当前 wopal-workspace 验证；model=wopal-ai/deepseek-v4.1-flash。已有 home/、spaces/ 内容保持，修改前备份；单元测试使用系统临时目录。
- 实施结束后按用户指定的分支切换方式加载两边候选版本，再在隔离 home 联合验证。切换前分别检查未提交变更，不覆盖其他任务。
- ~/.dsh 的新版配置只读参考，不修改它；不读取凭证、认证缓存、用户 .env 或真实 Session 内容。
- 代码改造按失败测试→实现→验证进行。提交限定本次路径；main 合入和远端推送不在当前授权中。

## Progress

- 两边隔离工作区已确认，ontology 新工作树已创建。
- 独立 DSH desktop 配置已使用声明式 preset、workflow-ptc 和 isolate 分组。
- 技能根需要单独适配：参考配置指向官方 agent-preset 附带技能，不能据此假定空间 dev-flow 等技能已加载。
- 开始固定依赖、Bridge ABI、生成 manifest/完整锁；随后处理 profile boot、模块路由、配置队列、配套资产及持久配置迁移。

## Verification

本节只记录实际执行结果，未执行的项目不标记通过。

### 2026-10-09 First Runtime Milestone

- 固定官方 DSH rc.2、Cordis 4.0.4、Loader 1.0.5、Include 1.0.9、Schemastery 3.18.4，Bridge ABI 2。
- 新 manifest fingerprint：sha256:1453f14b83d8e4974cb8e075aa59196e57adf2f78b32352e658ce3d066d9dcac；完整锁 608 个包，官方 DSH 均为 rc.2，Cordis 核心单一版本。
- `bun test src/runtime/upgrade-baseline.test.ts src/runtime/manifest.test.ts`：20 pass。
- `bun test test/profile-resolution.test.ts test/node-diagnostics.test.ts src/runtime/loader.test.ts`：8 pass。
- `bun test test/profile-hmr-transactions.test.ts`：3 pass。
- `bun test test/bun-hmr.test.ts test/upgrade-profiles.test.ts`：9 pass，含真实七工具、无 Session 生命周期和 Bun 三个健康 preset。
- Bridge `bun run typecheck`：exit 0。
- ontology adapter 的 pwsh→逻辑 bash 映射、同一权限和取消链已完成；完整 `bun test index.test.ts`：82 pass。

构建期完整锁生成在 Bun 下载旧 pako tarball时发生 TLS 校验失败，改用开发机已有 Node 的 `--experimental-strip-types` 运行原生成器成功；TLS 校验保持开启。产品运行时仍为 Bun/Electron，不增加用户安装 Node 的前置。

源依赖安装遇到同版 DSH scope 的 Bun peer 实例分裂，真实 default preset 绑定测试抓到该错误。保存旧依赖到 `.wopal-space/.tmp/ellamaka-dsh-pre-hoist-20261009`，固定并干净安装 hoisted 布局后，三 preset 绑定恢复；备份未删除。

以上只完成首个运行时里程碑。内部 package-worker、安装事务/版本门禁、旧配置/preset 导入、ontology 声明 bundle/技能根、各产品入口 ready/失败清理、真实构建与隔离联合验证仍在实施中，尚未交付用户验收。

### 2026-10-09 Joint Asset Milestone

- 数组 bundle 和 scoped remove 的 RED/GREEN 已完成；安装器回归 26 pass。
- 内部 `dsh package-worker` 已接入命令表，协议测试 2 pass；opencode 类型检查 exit 0。尚需真实 CLI 子进程/原生 UI 安装、取消、事务和版本锁验收。
- ontology `@wopal/dsh-presets@1.0.0` 标准 bundle 已生成，三声明由旧源文件可复现生成，旧源文件保留。
- 原 preset persona 的 text 在 rc.2 无效，已改 prefix 并保留原正文；旧 workflow-worker-thread 改 workflow-ptc；原已具备的 isolate 语义保留。
- 自带技能路径经标准 createRequire 定位包根，不使用无 inject 的上下文服务。
- `/private/tmp/dsh-joint-preset-probe.mjs` 在 Node 22.22.3、实际 rc.2 包、新临时 home 安装实际 ontology bundle后，wopal/fae/rook 均可 acquireScope，结果 joint-preset-binding PASS。尚不代表 PTC 程序/委派/技能执行、打包 Electron已通过。
- Bridge 广覆盖首轮 335 pass / 6 fail；失败为 settings 持久化位置、声明式 preset path 移除和相对认证重定向的旧断言。按真实新契约修正后，相关 isolation/Web 两组 27 pass，Bridge 类型检查 exit 0。
- 运行时约束在 profileContext overlays getter 和重放中重新生成；安装和重放仍需完整事务及坏输入去重收尾。

隔离目录 `/Users/sam/tmp/wopal-e2e` 已只读盘点：既有 home/ 和 spaces/uat-sandbox/ 保留，尚未写入、清空或启动该目录中的引擎。正式隔离候选装配、配置迁移与双分支切换尚未执行。

### 2026-10-09 Verified Upgrade Candidate

- 用户确认集成版配置位于 `/Users/sam/tmp/wopal-e2e/home/dsh/home/profiles/web/cordis.patch.yml`；独立官方 `_links/agents/dsh` 指向 `~/.dsh`，只作参考。用户在集成版认证入口自行输入 token，不在聊天或日志暴露凭证。
- 用户配合完成实际 provider/model 配置与 UAT，配置迁移按备份、集成版表单写入、用户确认执行。取消自动批量导入个人旧配置的实施路径。
- Bridge 广覆盖 341 pass；双容器插件生命周期与模块路由 11 pass；热加载事务/监听 10 pass；安装与协议/启动模式 31 pass。后续修改继续运行相关回归，不代表最终用户验收。
- 官方 loadProfile 会将坏 bundle 列为 skipped；Bridge 在已选择的 bundle 无法加载时显式拒绝候选。失败恢复最后成功 Include，相同坏字节不重复激活。
- 每个外部包从当前 profile 解析，采用 import 条件；不创建跨 profile 的同名共享用户包软链。
- 安装先生成候选实体，发布前检查取消；旧实体和 manifest 保留至所有目标 profile 完成。失败恢复已修改 profile，恢复失败保留备份并报告。CLI 先取得排序后的 profile 文件锁，再取全局安装锁；原生 worker 复用父进程持有的 profile 锁。
- 官方兼容性门禁处理 DSH peer 和精确版本豁免；内部 worker 使用宿主给定的 installAnchor，保持机器输出，处理 SIGTERM/SIGINT 取消。
- 已安装 Ellamaka 内置 Electron 41.2.1/Node 24.14.1 在临时 home 运行实际 rc.2 PTC：工具绑定、TypeScript、workspace-write 写入、空程序环境和 read-only 拒绝写入均通过，enforcement=full。Electron subprocess provider 仅对官方 PTC bootstrap 恢复 ELECTRON_RUN_AS_NODE；DSH 仍拥有控制通道、取消和子进程回收。文件沙箱证据不扩展为网络隔离证据。
- 实际三个 ontology preset 均发现 12 个技能，包括 dev-flow；fae/rook 显式挂载 provider 修复了旧继承假设。
- Node sidecar 构建成功；macOS arm64 CLI 构建及 version smoke 成功。Desktop 构建进行中，隔离 home 尚未写入。

### 2026-10-09 Current-space Validation Agreement

- 用户最终改为当前空间与实际 `/Users/sam/.wopal`，不装配有 Wopal CLI bug 的 uat-sandbox。隔离 home 已生成的 rc.2 闭包和备份保留。
- 实际 home 仍有旧 settings.yaml；旧 fakeip/sandbox-roots/Codex Connect/Sidebar/dshmarket 仅声明兼容 DSH 0.1。用户明确选择暂时停用旧插件，先验证核心与三个新 preset，再逐个恢复，不使用未经验证的精确版本豁免。
- 实际 DSH home 已完整备份到 `/Users/sam/.wopal/backups/dsh-rc2-20261009T043011Z/home`，379 MB；未输出凭证内容。旧 settings 会保留于快照并迁出活动 home，由用户在集成版表单配置 provider/model 和输入 token。
- 最终 Bridge 广覆盖 344 pass；新增多 profile rollback、版本门禁和 legacy settings 保留边界 9 pass。运行顺序发现的 Bun util 命名导出时序通过早期 preload 修复，Bridge、CLI/TUI 与 dev.sh 共用。
- TUI 真实挂载与 grep 执行 5 pass；Desktop 认证 cookie/代理路由 3 pass；Bridge、opencode、Desktop 类型检查通过。runtime manifest 和 608-package lock 的 --check 通过。
- macOS arm64 CLI、Node sidecar、Desktop 构建通过。构建目录由 CLI 重建后，顺序重新生成 sidecar，避免并发产物冲突。
- 当前两个候选升级 worktree 即将保存本次提交，再按用户要求切换主空间的模块分支；尚未把用户实际交互验证标记完成。

### 2026-10-09 Metadata Cold-start Repair

- 用户要求：个人配置迁移可手工，但首次启动必须自动初始化运行时/配置基础与插件元数据能力，不能依赖逐包修补。
- 修复覆盖 PluginPackages.metaOf（内置与预设清单）及 PluginManager.listBundles（官方可选/已安装 bundle 清单）。采用公开服务/导入接口适配，读取 ESM 导出资源及本地化；不执行插件代码或修改上游包。
- 全新临时 home 的真实两个 API 审计通过，覆盖官方条目、已启用全局激活状态、默认预设、缺失可选资源与有效标题；损坏 JSON、图标越界仍报错。
- 18 项相关回归通过，包括模块路由、两 profile 装配与双容器热加载生命周期；类型检查通过。
- CDP 真实页面：标准模式内置插件元数据错误 0；官方 bundle 清单元数据错误 0，显示中文名称“智能体团队、自动授权审查、自动化任务、语音输入”，网关无错误。旧 0.1 插件的兼容性诊断仍保留，不授予豁免。
