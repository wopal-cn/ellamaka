# DSH Customization Proposal

> **Status**: Proposed
> **Updated**: 2026-10-14
> **Parent**: `./DESIGN.md`
> **Scope**: DSH 空间皮肤、独立标签、实验 profile 与前端插件定制的后续设计方向

## Proposal Boundary

本文是后续讨论稿，尚未闭环。字段、命令形状、进程/注册模型与扩展接口均为候选方案，必须在固定 DSH 版本上验证后再定稿；不进入当前 Runtime Foundation、统一 SDK 或 CLI consumer Plan 的实现目标。

正式产品当前继续使用 Active Web 设计的双容器、单一公开端口和既有 iframe 承载。实验实例不能共享正式 Active Home，也不能成为 Home 回滚目标。

## 空间皮肤插件

一个插件实现「界面按空间定制」，含服务端与客户端两半。

- **空间识别**：服务端从当前会话的工作目录反查所属空间。dsh 会话按空间目录建立，空间目录带 `.wopal-space/` 标记，纯文件系统判断，不依赖跨引擎调用。
- **数据通道**：服务端在 `/dsh/*` 下暴露该空间的皮肤配置（主题变量覆盖、界面件开关、品牌资源）；客户端同源请求，在同源适配下天然可用。
- **界面件**：客户端按配置应用主题变量与声明式插槽——品牌位、输入框上下常驻信息条、会话头部动作位、自定义工具的对话卡片。
- **风格一致性**：主题变量对齐 workbench 设计语言，皮肤件与 workbench 共享同一套品牌资源。

界面定制只使用声明式插槽与主题变量，不整区替换，避免定制代码绑死界面内部结构。

## 多 profile 解耦

核心 Web 与工具属于同一产品 Runtime；Web 冷重建的进程边界遵循主设计的 Unified Reload，工具默认在宿主进程内。实验性的第三方 profile 以独立进程运行，带独立的 DSH_HOME，不进入主 Web 容器，不与主引擎共享 profile 目录。

### 空间模型

Workbench 顶栏的空间类型扩展为三类：

| 空间类型         | 标识               | 内容                              | 进程归属            |
| ---------------- | ------------------ | --------------------------------- | ------------------- |
| **助理**         | `assistant`        | ellamaka 原生通用会话空间         | ellamaka serve 进程 |
| **DSH**          | `dsh`              | dsh web profile，完整界面         | ellamaka serve 进程 |
| **实验 profile** | `dsh-profile:<id>` | 指定闭包与指定 profile 的隔离实例 | 独立进程            |

- 助理与 DSH 各自独立开关、独立持久化激活状态，互不遮蔽。
- 实验 profile 是注册式实体：一个实验 profile 对应一个独立进程与一个空间标签，携带独立入口地址与健康状态。
- 工具容器保持同进程，不作为独立空间呈现。它服务于工具投影，不是用户可见空间。

### 配置模型

dsh 相关配置采用两层模型：

| 层         | 位置                           | 作用                                          |
| ---------- | ------------------------------ | --------------------------------------------- |
| 默认值     | 空间配置的 `ellamaka.dsh.*` 域 | 定义各空间的启停默认值与实验 profile 注册清单 |
| 运行时覆盖 | 设置面板与持久化存储           | 用户界面内修改，立即生效并持久化              |

合并逻辑：面板有值用面板值，未设置回落配置文件默认值。

`ELLAMAKA_DSH=0` 仍然保留为硬禁用路径，环境变量显式设置时优先于配置。这保证配置损坏时仍有自愈手段。

### 进程拓扑

多个 `serve`、Desktop、TUI 与纯 native `run` 同时存在是 Core 产品要求；`run` 不参与 DSH profile 挂载或 Home 使用。同一 closure generation 下，各入口按自身正常职责直接挂载所需的官方 profile；Ellamaka 不选举 Home owner、不建立 single-owner hosting、不通过 proxy 共享 Web profile，也不为 `web` / `ellamaka-tools` 增加宿主级 writer lock。部分 DSH plugin/backend 可能尚未提供完整的跨进程一致性保证，因此多个 DSH-enabled 实例共享同一 Home 仍存在上游并发风险；该风险与直接运行多个官方 DSH 实例相同，是当前接受的已知限制。用户希望避免该风险时，可自行只保留一个 DSH-enabled 实例，并对其他实例设置 `ELLAMAKA_DSH=0`。

**核心容器由同一 Runtime host 拥有**。Web 与 tools 使用独立 Cordis context；Web 的冷重建可使用受管子进程，tools 保持 session-free backend。它们与用户独立启动的实验进程是不同生命周期边界，不通过共享 Web Home owner 解决上游并发问题。

**实验 profile 独立进程**。每个启用的实验 profile 由独立进程承载；它属于显式隔离实验域，不是正式核心 Active Home 的另一个版本，也不得被主 runtime 当作 Home 回滚目标。收益有三：

1. **闭包版本隔离**：实验进程可以绑定任意历史闭包，主进程继续跑当前闭包，避免单进程内双版本官方包冲突。
2. **故障防扩散**：实验插件崩溃、死锁或内存失控不影响主进程与正式 DSH 空间。
3. **home 隔离**：实验进程使用自己显式注册的隔离 DSH_HOME，不与核心 `$WOPAL_HOME/dsh/home` 共享 profile 目录。该例外只属于实验进程，不改变正式 Ellamaka runtime 的固定 Home invariant。

**启动范式**：独立启动加 Workbench 注册（用户自起、自己连）。`ellamaka dsh up --profile <name> --closure <fingerprint> [--port 0]` 独立跑出认证入口；Workbench 通过服务器管理界面注册，复用现有的添加、健康探针与持久化机制。注册后成为空间标签。主进程对实验进程零感知、零生命周期看管职责，隔离最干净。

### 闭包版本物化扩展

Runtime Manager 当前只物化宿主锁定的版本集。实验 profile 需要物化指定历史版本：

- 物化指定版本到 `closures/<fingerprint>`，复用现有的锁、暂存、校验、激活管线，版本来源从内嵌清单改为显式参数。
- 结果遵循闭包只增不减的约束，成功后永久保留，同指纹无限复用。

### 前端机制

- **标签模型**：助理、DSH、实验 profile 在顶栏并排；可见性从布尔派生改为按空间标识派生；激活空间决定呈现哪个表面。
- **保活 iframe 池**：每个 dsh 类空间持有一个保活 iframe，切换标签只切显示不重载，会话状态保留。
- **健康指示**：复用现有的按服务器健康探针机制，实验进程状态映射到空间标签指示。
- **信号绑定**：从单一的引擎挂载状态扩展为「引擎挂载态加实验空间清单」两类信号。

### 前端插件互通

dsh 前端插件体系与 Workbench 是两套框架，组件经 Web Component 跨框架互通。

**启动前提**（两条同时满足才排期）：

1. 插件生态在真实使用中：自建插件已日常在用，外部发现的插件中有被实际留存的案例。
2. Workbench 侧完成插槽化：已建立三到五个挂载点与属性契约。

**一个插件包的三个激活面**：profile 的 `package.json` 是唯一真相源，启用与禁用一个动作管三处。

| 面             | 目标                            | 激活契约                                 |
| -------------- | ------------------------------- | ---------------------------------------- |
| 服务端补丁     | dsh 服务端容器                  | profile bundle 层激活                    |
| 客户端         | dsh 界面                        | 官方客户端模块加载                       |
| workbench 界面 | Workbench 的 Web Component 插槽 | 满足本节启动前提后按插槽与加载器契约激活 |

新版面在插件声明中增加 workbench 界面段（入口文件与插槽清单）。插件作者用 React 写组件并包 Web Component 壳，或直接写轻量组件；Web Component 自包含运行时，Shadow DOM 提供样式隔离。

**数据通道**：dsh 容器的 HTTP 面挂在主服务器的 `/dsh/*`，Workbench 页面与之同源（生产同服务器，开发经代理转发）。dsh 第三方插件「服务端注册路由加客户端同源请求」的标准数据模式在 Workbench 中原样成立，改造量集中在界面壳。

容器未运行时，数据请求失败的降级语义由 Workbench 加载器承担：组件显示不可用态，不污染宿主。

**执行顺序**：同源连通 → 加载器最小链路 → 数据面实证 → 真实插件实证 → 失败语义。每步独立可逆。

**平台侧改造**：Bridge 提供 Web Component 文件的静态路由；Workbench 侧增加开发代理、插槽面（初始三到五个挂载点与属性契约）、组件加载器（读 profile 声明、过滤、动态导入、Shadow DOM 挂载、错误隔离、卸载）；供应链的启用面取值扩展加入 workbench。

**信任面**：Web Component 与 Workbench 同页面上下文，可信度等同于 dsh 插件同进程执行。用户显式安装加安装时的风险提示，不新增权限体系。此面不触碰官方闭包，不进入 dsh 界面运行时。


## Open Questions

- 固定 DSH 版本实际提供哪些稳定主题/插槽扩展接口；皮肤配置如何获取、校验和隔离失败？
- 助理/DSH/实验标签的状态、持久化、导航与远端 Server 切换如何一致？
- 实验 profile 的注册/认证/健康/退出由谁负责，地址与凭证如何保存？
- 指定历史 closure 的 manifest/lock 从何取得，Bridge 不兼容时如何明确拒绝，而非承诺任意历史版本都能运行？
- iframe 池的资源上限与关闭语义；实验进程不可用时怎样保留布局并给出诊断？
- 前端插件互通的真实需求与插槽前提是否成立；没有证据前不引入额外框架、权限系统或兼容层。

## Reference Documents

- `./DESIGN-dsh-web.md` — 当前 Active Web profile 与 Workbench 承载
- `./DESIGN-dsh-base.md` — 正式 Runtime 的固定 Home/closure 基本安全边界
- `./DESIGN-workbench.md` — 当前工作台布局、状态与资源生命周期
