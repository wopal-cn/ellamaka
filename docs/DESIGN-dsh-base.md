# DSH 融合基础设计

> **Status**: Active
> **Updated**: 2026-09-14
> **Parent**: `./DESIGN.md`

ellamaka 在自己的进程里运行 dsh 引擎，形成双引擎融合。本文描述两个 profile 共同依赖的宿主基座：dsh 的文件领地、依赖闭包与物化、模块热加载机制，以及 profile 目录的组织方式。

融合的整体架构、双容器模型与跨 profile 的运行时机制由主设计 [`DESIGN.md`](./DESIGN.md) 描述。

## DSH 文件领地

### 唯一领地根

`$WOPAL_HOME/dsh` 是 dsh 全部文件的唯一位置。serve、web、TUI、Workbench 后端与 Desktop sidecar 读写同一个目录。`~/.dsh` 属于 dsh 官方 CLI 的独立试验空间，ellamaka 不在其中读写任何内容。

```text
$WOPAL_HOME/dsh/
├── closures/                             ← 依赖闭包，按内容指纹命名
│   └── <fingerprint>/
│       ├── package.json
│       ├── package-lock.json
│       ├── runtime-manifest.json
│       └── node_modules/
├── home/                                 ← DSH_HOME：官方布局的 harness home
│   ├── profiles/
│   │   ├── node_modules/                 ← 宿主共享依赖层，官方包软链到闭包
│   │   ├── web/
│   │   └── ellamaka-tools/
│   ├── .agent-presets/                   ← 用户自建配置单根
│   ├── sessions/  storages/  attachments/
│   ├── settings.yaml  .credentials.yaml  .anonymous-user-id
│   └── cordis.patch.yml                  ← home 补丁层
├── staging/                              ← 物化临时区
└── locks/                                ← 物化与插件供应链的跨进程锁
```

`home/` 完整遵循官方生态的目录约定。官方 CLI 的 profile 布局、配置单用户根、插件市场状态目录都按官方语义就位，因此官方工具与 ellamaka 引擎读写同一套文件，互操作天然成立。

### DSH_HOME 的解析方式

宿主进程启动时设置 `DSH_HOME=$WOPAL_HOME/dsh/home`，由 `dev.sh` 注入后端、Desktop sidecar 注入环境变量。

这条环境变量存在的原因是官方包会在包内代码里直接读取它，例如 `dsh-agent-presets` 用它解析用户配置单根。这类直接读取是官方生态的既定做法，逐包重新适配不可行。设置这个环境变量让官方的 home 解析落在 ellamaka 领地内，永不落到 `~/.dsh`。

ellamaka 自己的集成代码不读这个环境变量，路径一律通过调用参数与配置注入传递。

### 闭包的可变与不可变边界

闭包按指纹固定，创建后不再修改。闭包内容是 dsh 版本化的官方运行时：引擎、官方工具插件、官方界面、官方配置单与内置技能。这些内容随 dsh 版本演进。

用户产生的内容全部落在闭包之外：自建配置单、用户技能、已装插件、profile 补丁。升级闭包不会丢失任何用户内容。

### 运行时数据

dsh 引擎的运行时数据统一落在 `$DSH_HOME`，即 `$WOPAL_HOME/dsh/home`。三类解析路径汇合到同一个目录：

| 路径 | 消费方 | 解析方式 |
|------|--------|---------|
| `ctx` 注入的 `dshHomePath` | profile 配置里的 `!!js dshHomePath(...)` 表达式 | 装配时提供函数，覆盖官方 boot 的环境变量读取 |
| 插件 `config.dshHome` | settings、credentials、agent-instructions、shell-env、skill-fs、attachment | profile 补丁层传入 |
| 环境变量直接读取 | `dsh-agent-presets` 用户根、anonymous-user-id、llm-deepseek | 宿主进程启动时设置 `DSH_HOME` |

## 依赖闭包与物化

### 发布边界

ellamaka 的发布物包含编译后的 DSH Bridge，不包含 dsh 官方运行时依赖。Bridge 是 ellamaka 自己的代码，随 CLI 二进制与 Desktop sidecar 一同构建，不发布为独立的 registry 包，也不作为 `$WOPAL_HOME/dsh/package.json` 的依赖。

```text
Ellamaka CLI / Desktop sidecar
└── 编译后的 DSH Bridge                    ← ellamaka 发布物

$WOPAL_HOME/dsh/closures/<fingerprint>/
├── package.json                          ← dsh 官方直接依赖
├── package-lock.json                     ← 完整解析树与完整性信息
├── runtime-manifest.json                 ← 本闭包的运行时清单副本
└── node_modules/@deepseek-ai/*           ← dsh 官方运行时
```

依赖方向始终是 ellamaka → Bridge → dsh 运行时。dsh 不依赖 Bridge。生产闭包里没有 `@wopal/ellamaka-cordis`、没有 workspace 软链、没有 TypeScript 源码副本。

### 版本来源

`packages/ellamaka-cordis/package.json` 的精确 `dependencies` 是 dsh 官方直接依赖版本的唯一编辑来源。构建流程从中选取 `@deepseek-ai/*` 依赖，生成 `dsh-runtime-manifest.json`。该文件是构建产物，随 CLI 与 Desktop sidecar 嵌入，不由开发者手工维护。

清单记录直接依赖的名称与精确版本、清单格式版本、Bridge ABI 版本与内容指纹：

```json
{
  "schema": "ellamaka.dsh-runtime/v1",
  "bridgeAbi": 1,
  "dependencies": {
    "@deepseek-ai/dsh": "0.1.1-rc.2",
    "@deepseek-ai/cordis": "4.0.2"
  },
  "fingerprint": "sha256:<manifest-digest>"
}
```

传递依赖树的解析与锁定发生在构建期。构建流程以清单的直接依赖版本调用 npm 解析出完整依赖树，产出内嵌锁 `dsh-runtime-lock.json`，随二进制一同嵌入。锁在编译期内联为 JavaScript 常量，运行时通过静态 import 读取内存对象，不读磁盘文件。

锁与清单指纹绑定：直接依赖版本变化必然触发锁重新生成，二者永远同步。

**可选依赖**：锁条目可以携带 `optional: true`，对应 npm 的 `optionalDependencies`，典型如平台原生绑定子包。物化时这些包下载失败只记警告并跳过，不阻断整个闭包；必装包失败仍然硬失败。某个 registry 镜像缺少官方源存在的平台包时，这个标记让镜像差异不阻断物化。

**锁的漂移门禁**：锁是构建产物，随代码入仓库。构建时比对锁绑定的清单指纹与当前清单指纹，不一致或缺失时自动重新解析并写回。发布与 CI 构建只做校验，锁过期即拦截构建。开发者升级依赖的唯一流程是改版本、`bun install`、构建。

运行时物化器只消费发布物内嵌的清单与锁，不读取 `latest`，不自行选择兼容版本，也不依赖源码仓库中的 `package.json`。普通配置不提供 dsh 版本覆盖项：Bridge 与 dsh 运行时作为一个经过验证的组合随 ellamaka 版本发布。需要独立升级 dsh 时，由发布流程交付新的完整运行时清单。

清单指纹覆盖直接依赖精确版本、清单格式与 Bridge ABI。目标闭包路径由该指纹确定，同一清单对应同一指纹。

### 启动语义

`ELLAMAKA_DSH` 是唯一的禁用开关，默认启用：

- 未设置或值不等于 `0`：启动 dsh Runtime Manager。
- `ELLAMAKA_DSH=0`：跳过清单检查、网络访问、物化、Bridge 加载与容器挂载，回到无 dsh 的基线状态。

所有入口共用 `@wopal/ellamaka-cordis/runtime` 下的 Runtime Manager：

| 用户入口 | 物化责任人 | 成功后的装配 |
|----------|------------|--------------|
| `ellamaka serve` / `ellamaka web` | 当前 ellamaka 进程 | Web 容器 + 工具容器 |
| `ellamaka` TUI | 当前 ellamaka 进程 | 工具容器 |
| 浏览器 Workbench | 承载 Workbench 的 serve/web 后端 | Web 容器 + 工具容器 |
| Desktop Workbench | Desktop sidecar | Web 容器 + 工具容器 |

浏览器与 Electron 的界面层不做文件系统物化。

dsh 初始化是启动阶段的一部分，采用阻塞等待：入口在提供 dsh 能力前等待该阶段完成。等待期间的体验约定：

- **进度**：物化按阶段输出进度（读取内嵌锁、下载、解压、校验、激活），日志含阶段名与包数。
- **超时**：整个物化阶段硬超时默认 5 分钟。超时进入 `degraded`，ellamaka 继续无 dsh 启动，本次不重试。
- **成本分布**：下载只发生在首次安装与指纹变更两个时刻。常规启动命中已验证闭包时只做本地快速校验，零网络、零等待。

### 物化状态机

Runtime Manager 对每次启动执行同一状态机：

1. **Gate**：读取 `ELLAMAKA_DSH`，值为 `0` 时返回 `disabled`。
2. **Resolve**：读取内嵌运行时清单，计算预期指纹与目标闭包目录。
3. **Inspect**：验证目标闭包的清单、锁、关键锚点与直接依赖版本。完整时直接进入 Load。
4. **Lock**：缺失或损坏时获取跨进程 `materialize.lock`。等待者在持锁者完成后重新 Inspect。
5. **Stage**：读取内嵌锁，用内置 `pacote` 按锁逐包下载并解压到 `staging/`。物化不依赖系统的 bun、npm 或用户 shell，也不在运行时解析依赖树。
6. **Verify**：校验锁的 npm v3 形状、`@deepseek-ai/dsh` 锚点、每个直接依赖的精确版本，以及 Bridge 需要的官方模块导出。
7. **Activate**：把通过验证的 staging 目录原子重命名为 `closures/<fingerprint>`。未通过验证的 staging 从不参与加载。
8. **Profile**：创建缺失的 profile 模板，已有 profile 与用户补丁保持不变。按本次 installAnchor 重建 `profiles/node_modules` 软链。
9. **Load**：以 installAnchor 动态加载官方运行时，挂载该入口需要的容器，返回 `ready`。

同一进程对初始化 Promise 做单飞复用。同一 `$WOPAL_HOME` 下的多个进程通过文件锁协调，只有一个进程下载和安装，其他进程等待并复用已验证闭包。

### installAnchor 与动态加载

installAnchor 是目标闭包内 `@deepseek-ai/dsh/package.json` 的绝对路径：

```text
$WOPAL_HOME/dsh/closures/<fingerprint>/node_modules/@deepseek-ai/dsh/package.json
```

它是模块解析锚点，不是下载地址，也不决定版本。版本由运行时清单决定。Bridge 以 installAnchor 创建闭包作用域的解析器，再从同一 `node_modules` 加载 cordis、dsh-app-boot、profile bundles 与其他官方模块。

Bridge 的生产代码不在模块顶层静态导入 `@deepseek-ai/*` 运行时包。类型依赖在构建期保留，运行时值通过 installAnchor 解析器获取。由此保证：

- CLI 与 Desktop 使用同一份磁盘闭包；
- 解析结果不受当前工作目录、workspace、全局 node_modules 或应用 bundle 影响；
- ellamaka 发布物不重复打包 dsh 官方依赖；
- Bridge 自身始终是已编译的 JavaScript。

### 升级与失败

指纹相同的闭包可以无限复用。新的 ellamaka 发布物携带新指纹时物化新闭包，已运行的旧进程继续持有自己的 installAnchor。新闭包验证成功后参与本次启动；版本不匹配时不回退到旧闭包，避免 Bridge ABI 与 dsh 运行时静默错配。

闭包只增不减：物化成功后永久保留，没有自动回收。磁盘占用等于本机出现过的版本指纹数，一般是两三份。清理方式是用户手动删除目录，或者使用显式命令（如 `ellamaka dsh cleanup --dry-run`），不属于启动行为。

`staging/` 由物化进程自己管理：持锁开始即清空残留，成功后原子重命名移入 `closures/`，失败时保留现场供诊断。

运行状态统一为四种：

| 状态 | 含义 |
|------|------|
| `disabled` | 用户以 `ELLAMAKA_DSH=0` 明确禁用 |
| `preparing` | 正在校验、等待锁或物化 |
| `ready` | 目标闭包通过验证且容器已挂载 |
| `degraded` | 本次启动的物化、校验、加载或挂载失败，ellamaka 无 dsh 继续运行 |

每次进程启动最多自动物化一次。网络不可达、超时、磁盘不足、完整性校验不匹配、锁异常与 Bridge 加载失败都进入 `degraded`，保留可诊断错误并在下次启动重试。失败的 staging 不会覆盖可用闭包。已有正确闭包时启动不需要网络。

**下载与缓存**：

- 物化器用 `pacote` 按内嵌锁逐包下载并解压，有界并发加进度日志。`pacote` 不做依赖树求解，在单文件二进制内稳定可用。依赖树的求解只存在于构建期源码环境：npm 的求解器在 `bun --compile` 单文件二进制内会陷入忙循环。
- registry 是传输通道，不是版本真相源。物化器对一组候选 registry 并发测速，选取本次启动最快可达的一个作为下载源；全部不可达时兜底官方 npm。换源不改变已锁定闭包。

## Profile 机制

每个 profile 目录包含三个文件：

| 文件 | 作用 |
|------|------|
| `package.json` | 声明 `dsh.profile.bundles` 有序列表与 `dependencies`（已装插件），是插件安装的唯一真相源 |
| `cordis.yml` | 插件行清单 |
| `cordis.patch.yml` | 用户补丁层，按 entry id 覆盖或禁用，应用于所有 bundle 层之后 |

- `web` profile：bundles 为 `dsh-base + dsh-web-app`，完整界面。
- `ellamaka-tools` profile：bundles 为 `dsh-base`，补丁层禁用 agent-loop 相关插件。

`initProfile` 只创建缺失文件，不覆盖已有文件。ellamaka 只在补丁层仍是空模板时播种默认禁用条目，用户编辑永不被覆盖。

`profiles/node_modules` 是软链目录。`healProfilesModuleFallback` 每次挂载时从 installAnchor 遍历依赖清单，为每个包建立软链，使 profile 插件行在 Loader 解析时找到宿主已安装的包。它不是独立安装，指向哪份安装取决于 installAnchor。

组合顺序：bundle 层（`dsh.profile.bundles` 逐包应用各自的 `cordis.patch.yml`）→ 用户补丁层 → Bridge 补充补丁 → home 补丁层。

## 模块热加载

### 官方机制

dsh 官方在 0.1.2-rc.1 把模块级热加载改为按 profile 显式启用，base bundle 默认关闭。

`profile-boot` 对 `patchReload: 'live'` 的 profile 在 hmr 未挂载时，会以 `config: { root: [] }` 挂载一个空根实例，只提供配置监听。但这条创建路径在 Bun 下第一步就抛错：官方 hmr 插件的构造器要求 `loader.internal` 存在，异常被静默吞掉。因此在 Bun 下，用户的补丁热加载在官方代码中完全不可用，配置监听与模块热替换都失效。

官方 hmr 对 Node 私有模块加载器有硬依赖：构造器要求 `ctx.loader.internal` 存在，模块热替换使用 Node 内部 ESM loader 的缓存与解析接口。Bun 下这个条件永远不成立。

当 Loader 没有 internals 时，裸包名导入走原生 `import()`，这是官方文档明确支持的降级路径。

### Bun 路径的替代实现

`@wopal/ellamaka-cordis/bun-hmr` 在 Bun 容器内实现官方的配置热加载契约，模块级热替换降级为事务性重载。在 Bun 路径上它以同一个 hmr 服务位替代官方插件。Node 路径按能力选择：只有运行时 Loader 确实公开了 internals 时才使用官方 `@deepseek-ai/cordis-plugin-hmr`；打包的 Electron utility sidecar 缺少该能力，同样回退到适配器，避免官方构造器让整个 profile 挂载失败。

官方调用方对 hmr 服务位的消费面精确为两个方法：`registerConfig(filename, refresh)` 监听单个文件、变更时串行执行 refresh、返回清理函数，重复注册同一路径抛错；以及通过 `entry.update({ config: { patches } })` 重放组合。refresh 闭包由官方提供，bun-hmr 只负责检测变更与串行调度。

因此适配器不需要复刻官方 hmr 的模块根与 watcher 配置面。官方调用方以空根挂载，语义就是只要配置监听、不要模块监听。错误契约也对齐：`registerConfig` 在服务未激活时抛错，官方调用方对未激活错误码静默降级为空操作，bun-hmr 保持同样的错误形状。

| 能力 | 官方语义 | bun-hmr 语义 |
|------|---------|-------------|
| `registerConfig` | 监听单文件，变更时串行执行 refresh | 原样实现 |
| 模块根监听 | 追踪模块依赖图、清缓存、按依赖分析热换插件 | 不支持，改用候选校验加原子替换 |
| `loader.exit()` 兜底 | 依赖树变化触发宿主重启 | 同语义，闭包级依赖变更由 Runtime Manager 走新闭包 |

### 模块替换在 Bun 下的实现路径

Bun 的模块缓存以去掉 query 的真实路径为键，附加内容哈希的 query 不产生新模块身份。因此绕开缓存只有更换真实路径一条路。隔离候选模块必须落在新文件名下，例如 profile 内的临时候选目录，才会被重新加载。

替换流程：

1. 插件或 profile 补丁变更时，Bridge 组合出完整的候选补丁栈。
2. 候选栈在隔离的容器中加载并激活校验，复用插件供应链的隔离挂载实现。
3. 校验通过后等待该容器没有进行中的请求，然后事务性执行 entry 更新，由官方 Loader 按 entry id 插拔，失败自动回滚旧栈。
4. 变更模块经真实路径的候选副本加载，已运行容器的旧模块实例随旧状态释放。

### 插件组合监听

`startDshPluginService` 监听 profile 组合文件（`package.json` 与 `cordis.patch.yml`）的变化，变化时对两个容器重放完整补丁栈。它是 Bun 下热挂载的底座：安装动作只是磁盘写入，热挂载由组合文件监听触发。

重放失败时保留上一次成功的哈希，等待下一次真实变化再试。清空哈希会导致下一个轮询周期再次读取同一份坏数据、再次失败，形成无退避的无限重试，进而重置连接、引发日志风暴。

### 打包 Desktop 的热加载路径

Electron utilityProcess 不暴露 Node 内部模块，`--expose-internals` 只进入 execArgv，内部模块仍然不可 require。因此官方 hmr 插件在打包 Desktop 上同样不可用，bun-hmr 适配器就是 Desktop 路径。热禁用后服务端卸载，客户端设置导航残留到页面刷新为止，这是已知限制。

### 已知的上游缺陷

**tool-cordis 注册表冲突**：官方按 manifest id 进程级去重并抛错，同一引擎第二个包含 `tool-cordis` 的配置单挂载仍会失败。宿主侧的缓解是 wopal 配置单不包含该行，并且同一引擎最多运行一个官方 cordis 配置单的活动会话，第二个会话挂载失败回落默认配置单。这是已知限制，不在宿主侧修改官方配置单。

**FrameQueue 无界**：官方帧队列无条件追加，没有帧数或字节上限。

**会话事件逐条持久化**：官方 agent-loop 对每个增量事件追加持久化，存储层的打包发生在写入时，运行时事件数不变。

这几项属于上游缺陷，宿主侧以「会话隔离加大会话不自动恢复」缓解，修复跟踪官方仓库。

## Related Documents

| 文档 | 引用目的 |
|------|---------|
| `research/deepseek-harness-architecture-and-integration-research.md` | dsh 全景调研 |
