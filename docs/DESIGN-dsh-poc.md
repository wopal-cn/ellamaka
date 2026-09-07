# DESIGN-dsh — ellamaka 与 dsh 融合架构设计

> **状态**：融合机制、生产物化、插件供应链均已实施并通过验收，进入维护态。**wopal 插件包（Agent 配置随包发布）是当前主线**；多空间解耦与实验 profile（E 线）为独立主线（2026-09-06 立项，暂不排期）；壳单端口化与 workbench 精简（S 线）为独立主线（2026-09-06 立项）；workbench 前端插件互通为启动前提明确的后续门槛轨道。
> **上级架构**：`DESIGN.md`
> **技术依据**：`research/deepseek-harness-architecture-and-integration-research.md`（dsh 全景调研）

**阅读地图**：架构总览 → 运行时机制 → 能力采用 → 配置与隔离 → 已验证事实 → 设计约束 → 生产物化验收基线 → 插件供应链 → **wopal 插件包（当前主线）** → **多空间解耦与实验 profile（E 线，独立主线）** → **壳单端口化与 workbench 精简（S 线，独立主线）** → workbench × dsh 前端插件互通（门槛轨道）。

本文档不使用章节号，交叉引用一律以标题文字为准（如「见「设计约束 · 不可变闭包」」）。

---

## 背景与目标

ellamaka 是 WopalSpace 的引擎（OpenCode fork）。为获得沙箱执行、插件生态、动态装载等能力，ellamaka 在自身进程内集成 dsh 引擎，形成双引擎融合架构。

**设计目标**：

1. **单一进程**：ellamaka 与 dsh 运行于同一进程，共享一个公开端口。
2. **能力复用**：ellamaka 直接采用 dsh 的工具能力（沙箱、搜索、文件操作），不重复实现。
3. **会话归属**：ellamaka 拥有会话与状态所有权。Web 容器承载 dsh 完整会话（见「架构总览 · 单进程、单端口、双容器」）；工具容器与 adapter 投影路径不创建、不持有任何会话，只提供执行能力（见「已验证事实 · 工具容器不持久化的成立条件」）。
4. **对外稳定**：ellamaka 的 API、SSE 事件、SDK 契约不因融合而变化。
5. **插件生态一体化**：dsh 插件可命令式安装、即时生效、跨重启保留，配置融入 ellamaka 配置体系（见「插件供应链」）。
6. **Agent 配置随包发布**：wopal 的灵魂与能力以 dsh 官方插件形态交付——配置单与自定义能力随插件包发布，用户安装即得（见「wopal 插件包」）。

**范围边界**：dsh 的会话/账本语义、调度、子代理等引擎能力不在工具采用范围内——这些能力依赖 dsh 自身的会话模型，与 ellamaka 的会话所有权冲突（见「已验证事实 · 深耦合能力不可采用」）。Agent 配置与组队能力（见「wopal 插件包」）运行在 dsh Web 容器内，使用 dsh 自有会话模型，不与 ellamaka 争抢会话所有权。

---

## 架构总览

### 单进程、单端口、双容器

ellamaka 进程内运行两个独立容器（Cordis container），共用 ellamaka 的唯一监听端口：

| 容器 | Profile | 职责 | 会话 |
|------|---------|------|------|
| **Web 容器** | `web` | 承载 dsh 完整 Web 界面（会话、账本、checkpoint、Agent 配置体系） | 有 |
| **工具容器** | `ellamaka-tools` | 提供纯工具执行后端，供 ellamaka 工具管道调用 | 无 |

```text
ellamaka 进程（唯一监听端口）
├── ellamaka 引擎 + Effect HttpApi    → /api/*、/workbench 等原生资源
│     └── ToolRegistry：内置工具 + dsh-adapter 投影的容器工具
├── /dsh/* → 受控 Node 路由挂载点 → VirtualWebServer（Web 容器）
│     ├── /api/*          → dsh 官方 connection 插件
│     ├── /api/events.*   → dsh 官方 WebSocket downlinks
│     ├── /plugins/*      → dsh 官方 modules 插件
│     ├── /plugins/events → dsh 官方 HMR 插件
│     └── /*              → dsh 官方 frontend-static
├── 工具容器（ellamaka-tools profile，无 webserver）
│     └── globalThis.__ellamakaDshContainer → dsh-adapter 调用工具
├── DSH Plugin Manager（见「插件供应链」）
│     └── `ellamaka dsh plugin` 命令 → profile 官方终态（node_modules + package.json 声明）+ 运行中容器热挂载
└── wopal 插件包（见「wopal 插件包 · wopal 插件包」）
      └── 配置单随包发布 → Web 容器会话按配置单装配
```

**两个容器必须分离**的原因：Web UI 需要 dsh 的完整 agent-loop 语义（会话账本 + checkpoint 屏障 + 完整插件集）；工具采用只需要工具本体 + 最小调用上下文。同一容器无法同时满足两种装配——checkpoint 插件会强制 flush 调用方的 live session（见「已验证事实 · 工具容器不持久化的成立条件」）。

**入口分工**：

- CLI serve / web：挂载 Web 容器 + 工具容器
- Desktop sidecar：挂载 Web 容器 + 工具容器（boot 系列自建容器）
- TUI：只挂工具容器（无 iframe 需求）
- Workbench：由承载页面的 serve/web 后端或 Desktop sidecar 提供 Web 容器与工具容器

### 组件清单

| 组件 | 位置 | 职责 |
|------|------|------|
| `VirtualWebServer` | `@wopal/ellamaka-cordis` | 实现 dsh 官方 WebServer 接口，提供路由/upgrade 分发，不创建监听 socket |
| 受控路由挂载点 | `Listener.mountNodeRoute` | 按前缀分发 HTTP/upgrade 到已注册 handler，保留 Effect listener 生命周期 |
| Ellamaka DSH Bridge | `@wopal/ellamaka-cordis` | 随 CLI 与 Desktop sidecar 编译发布；提供容器、虚拟 WebServer、运行时动态加载与 dsh boot 装配，不作为 DSH 闭包依赖发布 |
| DSH Runtime Manager | `@wopal/ellamaka-cordis/runtime` | serve、web、TUI 与 Desktop sidecar 共用的启动入口；负责禁用判断、闭包物化、完整性校验、动态加载和容器挂载 |
| DSH Plugin Manager | `@wopal/ellamaka-cordis/plugins`（随 Bridge 发布） | 插件供应链：安装区管理、依赖解析、热挂载与 profile 清单同步 |
| wopal 插件包 | `@wopal/dsh-wopal-pack` | 配置单 + 自定义能力随包发布，经官方 `config.roots` 注册为配置单根（见「wopal 插件包」） |
| DSH 运行时清单 | Ellamaka 构建产物 | 构建时从 `packages/ellamaka-cordis/package.json` 派生并锁定 DSH 官方依赖、完整依赖树与完整性信息；运行时内嵌读取 |
| dsh 引擎装配 | `@wopal/ellamaka-cordis/dsh-web` | 通过 installAnchor 从物化闭包加载官方运行时，重放 dsh boot 序列，构造两个容器；覆盖 `ctx.dshHomePath` 与插件 `dshHome` 配置注入，落地运行时隔离 |
| dsh-adapter | `.wopal/plugins/dsh-adapter` | 把工具容器中的工具投影进 ellamaka ToolRegistry |
| DSH home | `$WOPAL_HOME/dsh` | 不可变依赖闭包、用户插件安装区、profile 定义、运行时 state、Agent 配置单根的唯一位置 |

---

## 运行时机制

### 单端口分发

Dsh 的 Web 路由与 ellamaka 原生路由共用 ellamaka 的监听端口：

1. ellamaka Server 提供受控 Node 路由挂载点，保存前缀与 HTTP/upgrade handler。
2. `VirtualWebServer` 持有 dsh 官方插件注册的路由与 upgrade socket，暴露分发能力。
3. `mountDshWeb` 返回的 `webServer` 经 `Listener.mountNodeRoute({ prefix: "/dsh", ... })` 挂到主 listener。
4. 主服务器剥离 `/dsh` 前缀后，`VirtualWebServer` 看到的是官方 `/api`、`/plugins` 原始路径。

**边界**：

- 调用方获得 register/dispose 能力，不获得原始 `node:http.Server`。
- upgrade socket 由 `VirtualWebServer` 持有，在 host dispose 与主 listener 停止时销毁——补足 Node `closeAllConnections()` 不覆盖 WebSocket 的行为。

### 浏览器前缀适配

Dsh 前端在隔离 iframe 内加载。`VirtualWebServer` 在 index tap 链末尾注入适配脚本，把 DSH 浏览器传输映射到 `/dsh/*`：

- `fetch`（字符串、`Request`、`URL` 对象）、`WebSocket`、`EventSource`
- `document.createElement("script")` 动态加载的插件 bundle
- 覆盖相对路径与同源绝对 URL；外部 URL 与已带 `/dsh` 的 URL 保持不变

**静态资源路径**：rc.1 dist 的 index 使用文档相对路径（`./assets/*`），官方靠注入 `<base href="/">` 锚定根。index 变换把根绝对与 `./` 相对 URL 一并绝对化到 `/dsh` 前缀（免疫 base 标签逃逸），并移除 iframe 不需要的 PWA manifest link。

### 浏览器认证（rc.1 browser-auth）

rc.1 为 dsh web 面引入官方 `browser-auth`（`dsh-client-connection`）：进程持有 launch token，浏览器首访 index 必须带 `?token=` 交换一张 authority 绑定的签名 cookie（HttpOnly、Path=/、SameSite=Strict、默认 30 天），`/api` 通道叠加 Host/Origin trust fence（403）与 cookie 认证（401）两层栅栏；静态资源公开。集成忠实官方代码，不自造会话：

- **认证入口**：`mountDshWeb` 从官方 `connection` 服务现算 `authenticatedPath`（`/dsh/?token=...`，getter，不持久化 token）。
- **出站 Location 改写**：官方 token 交换 303 的 `location` 写死 `/`；`VirtualWebServer` 对 3xx Location 头做前缀改写（`/` → `/dsh/`），单端口方案下 iframe 登录不跳出挂载点。与 index 改写同属适配层职责。
- **下发通道**：serve 端 `mountDshEngine` 把 entry getter 发布到 `WorkbenchDshUrl`（模块级单槽，进程内单挂载）；`GET /workbench/dsh-url` 经已认证的 workbench API 现答 `{ url }`（引擎未挂载/禁用时 `url: undefined`）。token 只经 Ellamaka 已认证面下发。
- **前端消费**：`DshSurface` 经 SDK 取 URL，origin 与活跃 server 一致才采用，否则回落 `<server>/dsh/` 派生（browser-auth 关闭的部署）。同源判定把 loopback 别名归一化（localhost/127.0.0.1/[::1] 同 host 同端口视为同源），避免权威入口绑定 127.0.0.1 而 SDK 记忆 localhost 时 token 入口被误判为 stale 而回落裸 `/dsh/`。
- **dev 拓扑（SameSite 修复）**：cookie 是 SameSite=Strict，Vite :3000 → 后端 :4097 的跨站 iframe 带不上 cookie。`vite.config.ts` 把 `/dsh` 代理到后端（`ELLAMAKA_DSH_PROXY_TARGET` 可覆盖，ws: true），iframe 与 cookie 同 origin；Desktop/生产同源天然成立。`dshIframeSrc` 的 `pageOrigin` 参数把 entry URL 重定向到页面 origin。代理同时把 `Origin` 头对齐 target origin——rc.1 trust fence（`isTrustedApiRequest`）要求 `Origin.host === Host.host`，`changeOrigin` 只改写 Host 不改 Origin，代理必须显式改写 Origin 才能过 `/dsh/api` 与 WS upgrade 栅栏；Origin 从原始请求读取（vite 7 的 `proxyReq.headers` 在出站 ClientRequest 上 pre-send 不可读）。

#### 认证联盟的架构定位（2026-09-06 定稿）

ellamaka Basic 认证与 dsh browser-auth 是**两个信任域各守各的门**，不是重复建设：Basic 守外层（token 的分发面），cookie 守内层（dsh 自己的 `/api` 通道与 index）。iframe 内部跑的是 dsh 自己的 JS，其请求不携带 ellamaka 前端的 Basic 凭证——内层必须有一张 dsh 自认的凭证，官方形态即 cookie。**不做 Basic-only 统一**：认证机制不是 connection 插件的配置项，覆盖只有修改官方闭包一条路，违反「approval 原生边界」与生态对齐原则。用户感知上的统一（一次 Basic 登录，token/cookie 后台无感流转）已经成立，token 只经 Basic 保护的 `/workbench/dsh-url` 下发。

该联盟当前存在四个缺口，修复项如下（与「运行时机制 · 单端口分发」的挂载边界直接相关）：

1. **`trustedHosts` 配置化（auth-fix-1）**：dsh connection 的 fence 对非 loopback Host 强制匹配 `trustedHosts`，而挂载层硬编码空数组——LAN 部署（配了 `OPENCODE_SERVER_PASSWORD` 的场景）下 Basic 认证的 ellamaka API 远程可用，DSH iframe 却静默 403。修复：把 `trustedHosts` 暴露为 ellamaka 配置项（`ellamaka.dsh.trustedHosts`，默认值层进 `settings.jsonc`），经 profile 补丁层注入 connection 插件配置。官方 fence 本为此设计，零官方改动、零自造会话。
2. **iframe 401 自愈（auth-fix-2）**：cookie 过期（30 天）或引擎重启（新进程 = 新 token + 新签名密钥）后，dsh 返回裸 401 文本，iframe 停在死页。修复：`DshSurface` 增加 401 探测，命中即重取 `/workbench/dsh-url` 并重载 iframe src——token URL 重载即重新 303 铸 cookie，无感恢复。
3. **挂载认证策略显式化（auth-fix-3）**：`NodeRouteMount` 只有 `prefix/request/upgrade`，挂载即绕过 ellamaka 认证栈；今天安全成立靠 dsh 自身 fence 的隐式巧合。E 线实验 profile 是新的 self-auth 挂载前缀，必须防踩空。修复：`NodeRouteMount` 增加强制 `auth` 声明（`"self" | "public"`），dispatcher 固化不变量——新 mount 不允许默认无认证。
4. **WS upgrade 认证探针（auth-fix-4）**：`/dsh/api` HTTP 通道过 fence + cookie，但 WebSocket downlink 握手的认证路径未经实证。修复：探针测试未带 cookie 的 upgrade 请求；若不被拒，在宿主挂载层补 upgrade 前置 cookie 检查。

### iframe 地址派生

`DshIframe` 的 src 优先取 `/workbench/dsh-url` 的认证入口（见上），回落 `<server url>/dsh/` 派生，不写死相对路径。原因：ellamaka-app 的 dev 模式由 Vite 服务前端（默认 3000），后端 serve 独立监听（默认 4097）；相对 `/dsh/` 在 `:3000/workbench` 页面会解析到前端 origin。dev 下经 vite 代理指向页面 origin 的 `/dsh/`、Desktop 与生产指向后端 origin，两侧都命中 DSH 挂载点。

### 助理 tab 承载

Dsh iframe 的宿主是 workbench 的「助理」tab（General 空间 tab）：

- **派生可见性**：`dshVisible = dshEnabled && 激活 tab 是 General`。`dshEnabled` 来自 `/global/health` 的 `dsh` 字段（真值源 `ELLAMAKA_DSH` kill switch）。没有独立可见性信号，激活高亮、点击语义、持久化（`activeTabPath` 已持久化）三者天然一致。
- **keep-alive**：iframe 与原生工作区双层持久挂载，仅切 `display`；切 tab 不重载 iframe，DSH 会话状态保留（Space Keep-Alive 同款不变量）。
- **覆盖范围**：iframe 盖掉助理 tab 内容区全部（含 SpaceRail），dsh 界面自带侧栏；tab 名保持「助理」。
- **回落**：`ELLAMAKA_DSH=0` 时助理 tab 显示原生 General 会话空间，与 DSH 引入前行为一致；General 引擎作用域（`provisionGeneral`、会话投影、后台任务会话）不受影响。

> **演进**：本节描述的是 P7 遮蔽语义（DSH iframe 盖住助理 tab）。该耦合由「多空间解耦与实验 profile」演进——助理与 DSH 拆为独立空间，本节遮蔽模型在 E1 落地后退役。

### DSH home 与运行时隔离

#### 交付边界

Ellamaka 发布物包含编译后的 **Ellamaka DSH Bridge**，不包含 DSH 官方运行时依赖。Bridge 是 Ellamaka 自身代码，随 CLI 二进制与 Desktop sidecar 一同构建。它不发布为独立 registry 包，也不作为 `$WOPAL_HOME/dsh/package.json` 的依赖。

全部 `@deepseek-ai/*` 官方包在首次启用 DSH 时物化到 `$WOPAL_HOME/dsh`。这条边界在 dev、CLI 发布物与 Desktop 发布物中保持一致：

```text
Ellamaka CLI / Desktop sidecar
└── compiled DSH Bridge                  ← Ellamaka 发布物

$WOPAL_HOME/dsh/closures/<fingerprint>/
├── package.json                         ← DSH 官方直接依赖
├── package-lock.json                    ← 完整解析树与 integrity（构建期内嵌锁的落盘复本）
├── runtime-manifest.json                ← 本闭包对应的运行时清单复本
└── node_modules/@deepseek-ai/*          ← DSH 官方运行时闭包
```

Dsh 不依赖 Ellamaka DSH Bridge。依赖方向始终是 `Ellamaka → Bridge → DSH runtime`。生产闭包中没有 `@wopal/ellamaka-cordis`、`file:` workspace 链接、TS 源码副本或 Node TypeScript loader。

#### 唯一 home 与目录所有权

**唯一领地根（territory root）**：`$WOPAL_HOME/dsh`。serve、web、TUI、Workbench 后端与 Desktop sidecar 读取同一位置。`~/.dsh` 归 dsh 官方 CLI 独立试验专用，Ellamaka 不在其内读写。

**`DSH_HOME` 指向 `$WOPAL_HOME/dsh/home`**。宿主在进程启动时设置 `DSH_HOME=$WOPAL_HOME/dsh/home`（dev.sh 注入 backend、Desktop sidecar env 注入）。官方包在包级代码里直接 import `dshHomePath()`（读 `$DSH_HOME` env，如 `dsh-agent-presets` 的用户配置单根），这类 env 直读是官方生态的既定机制，逐包重新适配不可接受；设置 env 让官方语义的 home 解析落在 Ellamaka 领地内，永不落到 `~/.dsh`。Ellamaka 自己的集成代码（bridge/adapter/配置注入路径）不读这个 env，路径一律由调用参数与配置注入。

```text
$WOPAL_HOME/dsh/                          ← Ellamaka 领地根（不是 DSH_HOME）
├── closures/                             ← 按内容哈希命名的依赖闭包；只增不减，永不自动删除
│   └── <fingerprint>/                    ← 清单 sha256 摘要前 12 位 hex；同名即同内容
│       ├── package.json
│       ├── package-lock.json
│       ├── runtime-manifest.json
│       └── node_modules/
├── home/                                 ← DSH_HOME：100% 官方布局的 harness home
│   ├── profiles/                         ← 官方语义的 profile 区（跨版本保留）
│   │   ├── node_modules/                 ← 宿主共享依赖层：官方包 symlink 到闭包（heal 归位）
│   │   ├── web/                          ← profile 目录：package.json（dependencies + dsh.profile.bundles）、
│   │   │                                   node_modules/（已装插件实体）、cordis.patch.yml、.dsh-market/
│   │   └── ellamaka-tools/
│   ├── .agent-presets/                   ← 用户自建配置单根（官方位置）
│   ├── sessions/  storages/  attachments/ ← 运行时数据（官方位置；A 类包 config 注入同指此处）
│   ├── settings.yaml  .credentials.yaml  .anonymous-user-id
│   └── cordis.patch.yml                  ← home patch 层（官方位置）
├── staging/                              ← 物化临时区；持锁进程开始时清空，成功后移入 closures/
└── locks/                                ← materialize.lock（物化）与 plugins.lock（供应链）跨进程锁
```

`home/` 是官方生态契约的完整落地：官方 CLI 的 profile 布局、`dsh-agent-presets` 的用户根、`dshmarket` 的状态目录全部按官方语义就位。官方 `dsh plugin` 生态机制与 Ellamaka 引擎读写同一套 profile 文件，互操作天然成立。

闭包按指纹不可变。新 Ellamaka 版本需要不同的 DSH 依赖树时创建新闭包，不原地修改正在运行的闭包。`home/`、`presets/` 独立于闭包版本，升级时保持用户配置、生成物与运行时数据。

**闭包内容边界**：闭包 = dsh 版本化的官方运行时（引擎、官方工具插件、官方 client UI、官方自带配置单与内置技能）。这些是 dsh 的产品内容，随 dsh 版本演进而非随用户演进；用户的自进化内容（自建配置单、用户技能、已装插件、profile 补丁）全部落在闭包之外的可变区。升级闭包不丢任何用户内容。

#### 运行时清单与版本来源

`packages/ellamaka-cordis/package.json` 的精确 `dependencies` 是 DSH 官方**直接依赖版本**的唯一编辑源。Ellamaka 构建流程从中选取 `@deepseek-ai/*` 依赖生成 `dsh-runtime-manifest.json`。该文件是构建生成物，随 CLI 与 Desktop sidecar 嵌入，不由开发者手工维护：

- 直接依赖名称与精确版本，包括 `@deepseek-ai/dsh`；
- 清单 schema、Bridge ABI 与内容指纹。

清单不携带任何锁快照，也不从构建期锁文件（bun.lock）推导版本或 registry。传递依赖树的解析与锁定发生在**构建期**：构建流程以清单的精确直接依赖版本调用 npm（Arborist）解析出完整传递依赖树，产出一份**内嵌锁**（`dsh-runtime-lock.json`），随 CLI 与 Desktop sidecar 一同嵌入二进制。清单形态：

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

**内嵌锁**是构建期由清单解析出的完整传递依赖树快照，记录每个包的名称、精确版本与 `node_modules` 相对路径（含嵌套安装的同名不同版本条目）。它由 `Bun.build` 编译期内联成 JS 常量打进二进制，运行时通过静态 `import` 直接读取内存对象，不读任何磁盘文件。锁与清单指纹绑定：清单直接依赖版本变化必然触发锁重新生成，二者永远同步。

**optional 语义**：锁条目可选携带 `optional: true`，对应 npm `optionalDependencies`（典型如 `@koromix/koffi-*` 平台原生绑定子包）。物化器对这些包对齐 npm 语义——下载/解压失败记 warning 跳过，不阻断整个闭包；必装包任何失败照旧硬失败。某个 registry 镜像可能缺少官方源存在的平台包，optional 标记使镜像差异不阻断物化。

**锁的生成与漂移门禁**：锁是构建生成物，随代码入仓库（`generated/dsh-runtime-lock.json`），不由开发者手工维护。构建门禁比对锁绑定的 `manifestFingerprint` 与当前清单指纹，不一致或缺失时自动重新解析并写回，随代码一同提交；release/CI 构建只做 `--check` 漂移校验，锁过期即拦截构建。开发者升级依赖的唯一流程：改版本 → `bun install` → 构建。

运行时物化器只消费发布物内嵌的清单与内嵌锁，不读取 `latest`，不自行选择兼容版本，也不依赖源码仓库中的 `package.json`。普通配置不提供 DSH 版本覆盖项——Bridge 与 DSH runtime 作为一个经过验证的兼容组合随 Ellamaka 版本发布。未来如需独立升级 DSH，由发布流程交付新的完整运行时清单。

清单指纹覆盖直接依赖精确版本、schema 与 Bridge ABI。目标闭包路径由该指纹确定。同一精确版本清单对应同一指纹；内嵌锁由构建期解析产生，同一发布物在不同机器上物化出相同的闭包。**闭包一旦锁定即不可变**，二次启动零网络命中。换源不改变已锁定闭包。

#### 统一启动语义

`ELLAMAKA_DSH` 是唯一禁用开关，默认启用：

- 未设置或值不等于 `0`：启动 DSH Runtime Manager；
- `ELLAMAKA_DSH=0`：跳过清单检查、网络访问、物化、Bridge 动态加载和容器挂载，回到无 DSH 基线。

所有入口共用 `@wopal/ellamaka-cordis/runtime` 下的 Runtime Manager。

| 用户入口 | 物化责任人 | 成功后的装配 |
|----------|------------|--------------|
| `ellamaka serve` / `ellamaka web` | 当前 Ellamaka 进程 | Web 容器 + 工具容器 |
| `ellamaka` TUI | 当前 Ellamaka 进程 | 工具容器 |
| 浏览器 Workbench | 承载 Workbench 的 serve/web 后端 | Web 容器 + 工具容器；浏览器不执行文件系统物化 |
| Desktop Workbench | Desktop sidecar | Web 容器 + 工具容器；Electron Main/Renderer 不物化 |

Dsh 初始化是启动阶段的一部分，采用**阻塞等待**策略：入口在提供 DSH 能力前等待该阶段完成。等待期间的体验契约：

- **进度**：物化按阶段输出进度（读取内嵌锁 → 下载 → 解压 → 校验 → 激活），日志含阶段名与包数。
- **超时**：物化整个阶段硬超时默认 5 分钟。超时进入 `degraded`，Ellamaka 继续无 DSH 启动，本次不重试。
- **成本分布**：下载只发生在首装与指纹变更两个时刻。常规启动命中已验证闭包时只执行本地快速校验，零网络、零等待。

#### 物化状态机

Runtime Manager 对每次启动执行同一状态机：

1. **Gate**：读取 `ELLAMAKA_DSH`。值为 `0` 时返回 `disabled`。
2. **Resolve**：读取内嵌运行时清单，计算预期指纹与目标闭包目录。
3. **Inspect**：验证目标闭包的 manifest、内嵌锁、关键 anchor 与直接依赖版本。完整时直接进入 Load。
4. **Lock**：缺失或损坏时获取跨进程 `materialize.lock`。等待者在持锁者完成后重新 Inspect。
5. **Stage**：读取内嵌锁；用内置 `pacote` 按锁逐包下载 tarball 并解压到 `staging/`。物化不依赖系统 bun、npm 或用户 shell，也不在运行时解析依赖树。
6. **Verify**：校验内嵌锁的合法 npm v3 形状、`@deepseek-ai/dsh` anchor、每个直接依赖的精确版本，以及 Bridge 所需的官方模块导出。
7. **Activate**：把通过验证的 staging 目录原子重命名为 `closures/<fingerprint>`。未通过验证的 staging 从不参与加载。
8. **Profile**：创建缺失的 profile 模板；已有 profile 与用户补丁保持不变。按本次 installAnchor 重建 `profiles/node_modules` 快捷方式。
9. **Load**：以 installAnchor 动态加载官方运行时，挂载该入口需要的容器，返回 `ready`。

同一进程对初始化 Promise 做单飞复用。同一 `$WOPAL_HOME` 下的多个 Ellamaka 进程通过文件锁协调，只有一个进程下载和安装；其他进程等待并复用已验证闭包。

#### installAnchor 与动态加载

`installAnchor` 是目标闭包内 `@deepseek-ai/dsh/package.json` 的绝对路径：

```text
$WOPAL_HOME/dsh/closures/<fingerprint>/node_modules/@deepseek-ai/dsh/package.json
```

它是**模块解析锚点**，不是下载地址，也不决定版本。版本由「运行时清单与版本来源」的内嵌清单决定。Bridge 以 installAnchor 创建闭包作用域的 resolver，再从同一 `node_modules` 加载 `@deepseek-ai/cordis`、`dsh-app-boot`、`dsh-cmdline`、profile bundles 与其他官方模块。

Bridge 的生产代码不在模块顶层静态导入 `@deepseek-ai/*` 运行时包。类型依赖在构建期保留，运行时值通过 installAnchor resolver 获取。由此保证：

- CLI 与 Desktop 使用同一份磁盘闭包；
- 解析结果不受当前工作目录、workspace、全局 node_modules 或应用 bundle 影响；
- Ellamaka 发布物不重复打包 DSH 官方依赖；
- Bridge 自身始终是已编译 JavaScript。

#### 升级、失败与可观测状态

指纹相同的闭包可无限复用。新 Ellamaka 发布物携带新指纹时物化新闭包，已运行的旧进程继续持有自己的 immutable installAnchor。新闭包验证成功后才参与本次启动；版本不匹配时不回退到旧闭包，以免 Bridge ABI 与 DSH runtime 静默错配。

**闭包生命周期——只增不减**：物化成功后永久保留，无自动回收；磁盘占用 = 本机出现过的版本指纹数（一般 2~3 份），清理方式只有用户手动删除目录。`staging/` 由物化进程自管理：持锁开始即清空残留；成功后原子 `rename` 移入 `closures/`；失败时保留现场供诊断。如需便利清理，以显式命令交付（如 `ellamaka dsh cleanup --dry-run`），不属于启动行为。

运行状态统一为：

| 状态 | 含义 |
|------|------|
| `disabled` | 用户以 `ELLAMAKA_DSH=0` 明确禁用 |
| `preparing` | 正在校验、等待锁或物化 |
| `ready` | 目标闭包通过验证且容器已挂载 |
| `degraded` | 本次启动物化、校验、加载或挂载失败，Ellamaka 无 DSH 继续运行 |

每次进程启动最多自动物化一次。网络不可达、超时、磁盘不足、integrity 不匹配、锁异常和 Bridge 加载失败均进入 `degraded`，保留可诊断错误并在下次启动重试。失败的 staging 不会覆盖可用闭包。已有正确闭包时启动不需要网络。

**下载与缓存**：

- 物化器用 `pacote` 按内嵌锁逐包下载 tarball 并解压（有界并发 + 进度日志）。`pacote` 不做依赖树求解（树已在构建期解析并内嵌），在 SEA 单文件二进制内稳定可用。**官方闭包的树解析只存在于构建期源码环境**：Arborist 的树求解在 `bun --compile` 单文件二进制内会陷入忙循环（见「已验证事实 · 插件供应链实测事实」）；用户插件的传递树解析走「插件供应链」的最小解析器，不受此约束影响。
- registry 是**传输通道，不是版本真相源**：物化器对一组候选 registry 做并发测速，选取本次启动最快可达的一个作为下载源；全部不可达时兜底官方 npm。换源不改变已锁定闭包。

#### 运行时数据隔离

Dsh 引擎的运行时数据（settings、credentials、匿名用户 ID、sessions、storages、home patch）统一落在 `$DSH_HOME` = `$WOPAL_HOME/dsh/home`（官方语义位置）。三类解析路径汇合同一目录：

| 路径 | 消费方 | 解析方式 |
|------|--------|---------|
| `ctx` 注入的 `dshHomePath` | profile 配置 `!!js dshHomePath(...)` 表达式（storages/sessions） | 装配时 `ctx.provide("dshHomePath", (...s) => join(homeDir, ...s))`，覆盖官方 boot 的 env 直读注入 |
| 插件 `config.dshHome` | settings/credentials/agent-instructions/shell-env/skill-fs/attachment | profile patch 层传 `dshHome: $DSH_HOME` |
| env 直读（官方生态机制） | dsh-agent-presets 用户根、anonymous-user-id、llm-deepseek | 宿主进程启动时设置 `DSH_HOME=$WOPAL_HOME/dsh/home` |

`~/.dsh` 归官方 CLI 独立试验专用；Ellamaka 全程不读写。

### Profile 机制

每个 profile 目录含：

| 文件 | 作用 |
|------|------|
| `package.json` | 声明 `dsh.profile.bundles` 有序 bundle 列表 + `dependencies`（已装插件）；这是插件安装唯一真相源（见「插件供应链 · 真相源与目录布局」D-04） |
| `cordis.yml` | 插件行清单 |
| `cordis.patch.yml` | 用户补丁层，按 entry id 覆盖/禁用，应用于所有 bundle 层之后 |

- `web` profile：bundles `dsh-base + dsh-web-app`，完整 UI。
- `ellamaka-tools` profile：bundles `dsh-base`，补丁层禁用 agent-loop 专属插件（禁用清单见「能力采用 · 工具容器装配」）。
- `initProfile` 只创建缺失文件不覆盖；ellamaka 只在补丁层仍是空模板时播种默认禁用条目，用户编辑永不覆盖。
- `profiles/node_modules` 是快捷方式目录：`healProfilesModuleFallback` 每次挂载时从 installAnchor 遍历依赖清单，为每个包建 symlink，使 profile 插件行在 Loader 解析时找到宿主已安装的包。它不是独立安装，指向哪份安装取决于 installAnchor。

---

## 能力采用

ellamaka 通过工具容器采用 dsh 的工具能力。采用原则：**每个能力逐项评估，采用成本超过独立实现成本时保留 ellamaka 原生能力**。dsh 是能力来源，不是必须迁入的运行时归宿。

### 采用边界

| 能力形态 | 采用方式 |
|----------|----------|
| 输入输出与生命周期可由 dsh 通用工具契约表达 | 经 dsh-adapter 投影进 ellamaka ToolRegistry |
| 只需少量调用上下文 | adapter 按需传入最小 per-call context，缺省字段省略 |
| 依赖 dsh 沙箱底座 | 在工具容器内装配沙箱后端，工具在沙箱内运行 |
| 依赖 dsh 自身的 session / agent loop / 事件日志 / 子会话语义 | 不采用该包，按 ellamaka 数据模型复刻所需机制 |
| 依赖 ellamaka Hook / Session / Permission / UI | 由 ellamaka 原生插件负责 |

**已采用能力**：

| 能力 | 工具 | 后端 | 沙箱 |
|------|------|------|------|
| 文件搜索 | `grep` / `glob` | `fs-search` | 无（纯读取） |
| 文件操作 | `read` / `write` / `edit` | `tool-fs` | `fs-sandbox` |
| 字符串替换编辑 | `str_replace_editor` | `tool-str-replace-editor` | `fs-sandbox` |
| 命令执行 | `bash` | `tool-bash` | `bash-sandbox` |

**保留 ellamaka 原生实现**：`edit`、`read`/`write`、`wopal_task_*`（现有语义或宿主集成更重要）。

**需原生复刻（深耦合，不采用）**：session-query、schedule、subagent 等引擎能力包（见「已验证事实 · 深耦合能力不可采用」）。

### 工具容器装配

工具容器装配 `fs-sandbox` / `bash-sandbox` 沙箱后端，使 `ctx.fs.sandboxMode` / `ctx.shell.sandboxMode` 有值，`sandboxPolicy.resolve()` 参与执行链。容器内不创建任何 dsh session。

补丁层禁用 agent-loop 基础设施（session、agent-loop、llm、subagent、jobs、goal、plan-mode、compaction、web 等约 57 行，按依赖分组附理由），只保留工具注册表与执行链（tools、system-prompt、subprocess、fs、sandbox、spill、tool-fs、tool-fs-search 等）。

**两个已确认的容器语义**：

1. **工具容器不做请求边界持久化**：`session-checkpoint-policy` 插件监听 `tools/execute`，对 live session 执行账本 flush。adapter 不传 live agent 时它短路放行。工具容器在 profile 层禁用该插件——不创建、不持有任何 session，账本持久化缺失不产生功能影响（见「已验证事实 · 工具容器不持久化的成立条件」）。
2. **后台任务能力禁用**：`jobs` 未装配，工具容器隐藏 `run_in_background`，schema 隐藏该字段，强制传入时由 dsh 拒绝。

### 工具投影（dsh-adapter）

dsh-adapter（`.wopal/plugins/dsh-adapter`）把工具容器中的工具投影进 ellamaka ToolRegistry：

- **映射白名单**：配置 `tools: [{source, target, enable}]`。同名 target 覆盖 ellamaka 内置工具；容器缺失时 adapter 挂 0 个工具，内置工具原样可用。
- **schema 投影**：把 dsh 的 JSON Schema 解包为 ellamaka 插件 SDK 的 ZodRawShape；不支持的类型降级 `z.unknown()`，dsh schema 扩展不破坏投影。
- **参数映射**：dsh 蛇形参数（`file_path`）重命名为 ellamaka 驼峰（`filePath`），投影时重命名、execute 时转回。
- **结果映射**：dsh 的 `meta.diffs` 映射为 ellamaka 的 `filediff`（`file`/`patch`/`additions`/`deletions`），hunk diff 算法在 adapter 内自持，不 import dsh 包。前端零改动。
- **调用日志**：adapter 经容器 logger 记录每次调用（成功/失败，携带 tool/sessionID/callID），落入 `dsh-plugins.log`。
- **权限门禁复用**：adapter 在执行前复用 ellamaka 的 read/edit 与 external_directory 权限门禁。

**动态装配**：adapter 注册 `"tool.provider"`，每次调用实时读 `container.get("tools").schemas()`，不再启动时冻结。dsh 插件动态加载/卸载 → 工具增删 → 下一轮模型请求自动看到新集合；同名 dsh 工具卸载后内置工具自动恢复。工具集合真变化时缓存失效是预期行为；未变化时通过确定性投影 + 名字排序保证字节一致、缓存命中。

### 沙箱语义

工具调用经 adapter 投影时，按 ellamaka session 复用最小 facade：`session.header.cwd`（spawn 工作目录）、`session.header.id`（归属标签）、`session.events`（沙箱模式折叠）。其他一切省略。

沙箱模式在运行时决议（见「配置与隔离 · 沙箱配置」）：

- **启用沙箱**：注入 `sandbox/mode` 事件，`mode` 在 `read-only` 与 `workspace-write` 间选择。
- **关闭沙箱**：注入 `danger-full-access`，工具在容器默认后端下运行。**不切换本地 fs/bash 后端**——工具始终走同一容器与已装配的沙箱后端，关沙箱只是放开有效模式。

`danger-full-access` 保留为 dsh 内部一次性 escalation 目标，不作为空间级配置值暴露。

### escalation 审批桥接与沙箱三态切换

沙箱拒绝后，dsh 模型可回填 `sandbox_permissions` + `justification` 申请一次性更宽模式。该申请经 dsh 原生 approval 服务审批——工具容器**原生启用** `approval` 插件，由 adapter 补齐其运行时前置条件，审批决策经桥显示在 Workbench 权限卡片。

**adapter session 门面扩展**（「工具投影」facade 的增量）：

| 扩展 | 语义 |
|------|------|
| `append(type, data)` | 往自持 events 数组 push，approval 审计对（`approval/asked` + `approval/decided`）落内存不落盘 |
| turn 包裹 | 每次 `tools.execute()` 外层 `turn/start` → 执行 → `turn/end`（引用计数，finally 保证闭合，并发/嵌套仅最外层闭合） |

两者合起来满足 approval 插件的 `hasOpenTurn` 前置条件。工具容器仍不创建持久会话（「已验证事实 · 工具容器不持久化的成立条件」语义 1 不变）。

**approval answerer 桥**：adapter 在容器 ctx 上注册 `approval/request` waterfall listener，按 `req.agent.session.header.id`（= ellamaka sessionID）从 `askRegistry` 取执行时注册的 ask 闭包，构造 `sandbox_escalation` permission ask（patterns = 目标模式，从 escalation reason 解析；metadata 携带 toolName/callID/justification）。决策映射：

| 用户决策 | dsh outcome |
|---------|------------|
| once | `allowed-once`（dsh 原生 one-shot，仅本次调用以更宽模式执行） |
| always | ellamaka Permission 规则池承接（会话内同 pattern 免再问），dsh 侧返回 `allowed-once` |
| reject | `rejected` |
| 无 ask 闭包（TUI 等无 UI 入口） | `next()` 委托 waterfall 兜底 `unavailable`（fail-closed） |
| abort | dsh 原生 `cancelled`（ApprovalService 与请求信号 race） |

**escalation 策略**：`ellamaka.dsh.sandbox.escalation: "ask" | "never"`（默认 `ask`）。`never` 时 adapter 向每个 facade seed `approval/policy` session 事件（dsh 原生 fold 语义，LAST 优先），approval 服务在 waterfall 之前确定性拒绝，answerer 零调用。沙箱关闭（full-access）时 escalation 字段不广告，无需处理。

**沙箱三态切换（per-session）**：Workbench chat composer 底栏 `ComposerSandboxControl` 下拉（只读 / 工作区写入 / 完全访问），选择按会话存浏览器 storage（workspace 存储，按 sessionID 分桶），不改写任何 settings 文件。选择随消息携带：提交时经 `FollowupDraft.sandboxMode` 进入 prompt payload，`UserMessage.sandboxMode` 持久化（fork/queue 继承），`SessionTools.resolve` 透传进 `Tool.Context.extra`；adapter 在每次 `tools.execute()` 读取 `extra.sandboxMode`，有值即 append `sandbox/mode` 事件（LAST-wins，立即生效）。无选择回落空间默认（「配置与隔离 · 沙箱配置」）。`full-access` 映射事件值 `danger-full-access`（见「沙箱语义」）。显示条件（运行时事实，非配置字符串）：dock composer 且 DSH 运行时状态为 `ready`（kill switch 开、非 `degraded`）且实例级（目录）生效配置含 dsh-adapter 插件；任一不满足即隐藏。运行时状态由 `/global/health` 的 `dsh` 字段提供（`disabled`/`ready`/`degraded`）。不使用 dsh permission-presets。

**fold 不变量**：显式选择必须总是追加事件，即使该值等于空间默认。事件日志按 LAST-wins 折叠，"恢复默认"只能靠显式写入默认值；把"等于默认"优化成"不追加"会让会话滞留在上一次的 override 上。`extra.sandboxMode` 缺失才是"沿用当前折叠值"的唯一信号。

---

## 配置与隔离

### 进程级共享、空间级隔离

**容器装配是进程级共享能力池**：serve/TUI/desktop 各挂一个工具容器，进程内所有空间共用。容器载入完整工具链，禁用清单只管 agent-loop 基础设施，不管工具。装配一次，所有空间共用。

**工具投影是空间级隔离点**：每个空间的 `.wopal/config/settings.jsonc` 声明自己的 adapter 映射白名单与沙箱策略。adapter 按空间加载，各带各的配置——空间 A 开 grep+glob，空间 B 开 grep+glob+bash，互不影响；未开映射的空间用 ellamaka 内置工具。

**配置层级走 ellamaka 原生合并**：用户级 → 空间级 → 空间本地，逐层覆盖。

### 沙箱配置

空间级 `.wopal/config/settings.jsonc`（+ `settings.local.jsonc`）拥有工具容器的沙箱策略，配置形态为 `ellamaka.dsh.sandbox: { enabled, mode }`：

| 配置 | 含义 |
|------|------|
| `enabled: true` | 启用沙箱，`mode` 在 `read-only` 与 `workspace-write` 间选择 |
| `enabled: false` / 缺失 | 关闭沙箱，注入 `danger-full-access` |

进程级默认值只在尚未解析空间配置时兜底。**不用 `DSH_PERMISSION_MODE` 环境变量**——沙箱策略由空间配置拥有。

### 沙箱平台支持

dsh 沙箱后端 `@deepseek-ai/dsh-sandbox-local` 三平台支持（已实测 macOS）：

| 平台 | 机制 | 依赖 | 强制完整度 |
|------|------|------|-----------|
| macOS | Seatbelt（`sandbox-exec`，系统自带） | 无 | full |
| Linux | bwrap（bubblewrap）优先，回退 Landlock | bwrap 需安装 | full（老内核自报 partial） |
| Windows | ACL restricted-token runner | 自带 runner | partial（两个已知缺口） |

探测失败即拒绝执行（`SANDBOX_UNAVAILABLE`），不裸奔。

---

## 已验证事实

> 本节事实经源码实证或实测固化，是设计决策的依据。表述为结论，不展开推导。

### 深耦合能力不可采用

session-query / schedule / subagent / system prompt 注入等能力依赖 dsh 的引擎层语义（事件日志语料重放、agent.send 唤醒通道、子会话模型）。契约桥只能翻译接口层形状，翻译不了引擎层语义。这些能力的获取路径是**原生复刻**（机制设计可剥离，包与数据模型不可复用）。

**重要区分**：上述"深耦合"指引擎能力包。工具插件（tool-fs、tool-bash、tool-fs-search 等）**不在深耦合之列**——它们是叶子工具，只消费 session 的浅层形状，不依赖 agent-loop 语义。

### 工具消费面

对工具容器采用的全部能力做源码级盘点。结论：**工具插件的 session/agent 依赖是浅层的，无一个需要深 agent-loop**。分三类：

| 类别 | 特征 | 工具 |
|------|------|------|
| **A 纯形状** | 只读 `header.cwd` / `header.id` 标量 | `tool-fs-search`、`spill-policy` |
| **B 语义事件** | 折叠 `session.events` 读 `sandbox/mode` 覆盖 | `tool-fs`、`tool-str-replace-editor`、`tool-bash` |
| **C 语义写** | 写持久事件或依赖瀑布 | `tool-fs`、`tool-str-replace-editor`（emit `fs/observed`）、`fs-observation-policy` |

**两个关键纠正**：

1. `session.events` 缺失不会 TypeError：真 dsh Session 的 events 恒为数组。adapter 喂 `events: []` 是防御性而非必须。
2. `session.id` 不是临时目录隔离键：隔离键是 `header.cwd`，`id` 只喂 spill/日志，缺了无害。

### 服务依赖

| 服务 | 真必需 | 仅可选检查 |
|------|--------|-----------|
| `tools` | 全部工具 | — |
| `fs` | tool-fs、str-replace-editor | — |
| `shell` | tool-bash | — |
| `shellEnv` | **tool-bash 唯一硬依赖** | — |
| `systemPrompt` | tool-fs、tool-fs-search、tool-bash | sandbox-policy |
| `subprocess` | tool-fs-search | — |
| `sandboxPolicy` | 工具在沙箱内运行的决议组件 | — |
| `approval` | 无任何工具无条件需要 | tool-fs、tool-bash |
| `jobs` | 无（仅 run_in_background 启用时） | tool-bash |
| `spillStore` | 无（处处 ctx.get 降级） | tool-fs-search、spill-policy |

**最小可行 session 形状** = `header.cwd` + `header.id` + `events: []`。`approval`/`jobs`/`spillStore` 均非硬依赖。

### 工具容器不持久化的成立条件

`session-checkpoint-policy` 监听 `tools/execute`，对 `exec.agent.session` 执行账本 flush（"执行副作用前账本已持久化"）。adapter 不传 agent 时它短路放行；传入轻量 agent 时抛 `session not live`。因此工具容器在 profile 层禁用该插件。

**推论**：工具容器不做请求边界持久化，但也不创建、不持有任何 session，账本持久化的缺失不产生功能影响。Web 容器保持完整 profile，checkpoint 与 UI 模式照常。

### 桥接 API 规范

从 async 侧（Cordis 服务）调回 Effect 世界的桥接遵守以下形态（已实测固化）：

1. **持有 work Fiber 必须 `Effect.forkIn(scope)(work)`**：在 `Effect.scoped` 内取 scope，`forkIn(scope)` 直接返回持有的 work fiber。禁止 `ManagedRuntime.runFork(work).pipe(Effect.forkIn(scope))`。中断经 `runtime.runFork(Fiber.interrupt(fiber))`。禁止 `runPromise` 驱动长任务。
2. **顶层 Effect.runFork/runPromise/runCallback 在运行时未导出**——一律经 `ManagedRuntime` 实例方法调用。
3. **`Effect.scope` 须在 `Effect.scoped` 内获取**，否则以空 defect Die。
4. **ALS 上下文**：effect 体内发起的桥接调用沿传播链天然继承 Instance ALS；纯 async 侧发起的轮次须捕获-恢复 ALS。
5. **取消语义**：interrupt 后 finalizer 按子先父后顺序确定性执行，`forkIn(scope)` 的并发子任务级联清理。Cordis 入口只启动不拥有中断权。

### 插件供应链实测事实（2026-09-02，真实官方包）

对真实 `@deepseek-ai/*` 包（cordis 4.0.2、cordis-plugin-loader 1.0.3、dsh-app-boot 0.1.1-rc.2）验证，实验记录 `.wopal-space/.tmp/dsh-plugin-spike/SPIKE-REPORT.md`：

1. **运行中容器热挂载成立**：`loader.create({ name, config })` 向已启动容器挂载插件，服务立即可读；`loader.remove(id)` 卸载，effects 干净反解；root include 的 `entry.update()` 事务性插拔（按 entry id diff，自动 mount/unmount）同样成立。**无需重启容器，无需 patch 官方 Loader**。
2. **编译二进制内运行时依赖解析成立**：约 150 行 BFS 解析器（abridged packument + semver range + hoist 去重）在源码（991ms）与 `bun --compile` 二进制（1065ms）内均正确解析传递树，无忙循环。Arborist 忙循环约束只针对官方闭包的大树求解，不阻塞用户插件的小树解析。
3. **实现契约**：include `entry.update()` 是浅合并——更新 patches 必须先展开旧 config（否则 `path` 字段丢失报 `extension "" not supported`）；裸包名解析经 `loader.internal.import` 缝隙 + `profiles/node_modules` symlink parent-walk（`add` 后必须重跑 heal）；`mountRootInclude` 由 `dsh-app-boot` 导出；root config 扩展名仅 `.json/.yaml/.yml`。

### 生成 SDK 的双文件一致性

hey-api 生成的客户端由两个文件共同决定一个字段的线上行为：`types.gen.ts`（类型层）与 `sdk.gen.ts`（运行时 `buildClientParams` 映射层）。**类型存在 ≠ 运行时发送**：HttpApi 新增 payload 字段后若只再生成类型（或生成中断留下半新状态），`sdk.gen.ts` 映射缺键会让客户端在编码时静默丢弃该字段——无报错、无日志。验收方式：对新增字段 grep 两个文件都要命中；或跑 `bun script/build.ts` 全量再生成并 diff。

### 权限规则的合并顺序语义

Permission 评估为 LAST-wins（`findLast`），规则表顺序 = frontmatter 键声明序经合并后的位置。同一名 agent 的配置可来自多副本（`~/.wopal` home + 空间 `.wopal`），经 `mergeDeep` 按插入序合并：后加载副本的键保留其声明位置，显式 `x: ask` 可能被先声明但在合并序中靠后的 `"*": allow` 通配压过，静默放行。**不变量**：需要收窄通配的显式规则，必须保证其在合并后的最终规则表中位于通配之后；最稳妥的写法是 frontmatter 不声明通配（引擎 defaults 已提供 `"*": allow` 兜底），只写显式例外。验收方式：`GET /agent` 查看活实例合并后的规则表，确认显式规则位于相关通配之后。

### Agent 配置体系机制事实（2026-09-03，闭包源码实证）

1. **配置单（agent preset）= 一个会话主 Agent 的装配清单**：一个目录含 `agent.cordis.yml`（插件行清单）与可选 `preset.yml`（展示元数据）。会话按所选配置单装配工具、人格、技能与行为配置。
2. **双根发现与优先序**：官方根（`dsh-agent-presets` 包内 shipped 集合，trust=system）+ 用户根（`$DSH_HOME/.agent-presets/` = `$WOPAL_HOME/dsh/home/.agent-presets/`，trust=user，首次写入时创建）。roots 数组按优先序去重，**earlier root 赢得重复 id**；用户根恒排最后，因此用户根的同 id 目录被官方静默遮蔽（不报错、不生效）。
3. **Bridge 装配点**：`mountDshWeb` 以 agent-presets extraPatch 注入 `default: "standard"` 与官方根；roots 是宿主可配数组，追加自定义 system 根是一行配置。
4. **配置单服务能力完整**：`agentPresets` 服务提供 `list/resolve/mount/read/copy/remove/composeFrom/recompose/standingKeyFor`；`copy(from, id, name)` 是官方钦定的 authoring 路径（校验 id 形状、拒绝覆盖、失败回滚）。
5. **工具可见性的引擎级开关**：`tools.restrict({ allow?, deny? })` 按**Agent 作用域**收窄武器——命中名单的工具从该 Agent 的模型视野中完全移除（schema 不下发，token 一并消失）；引擎强制拒绝无作用域的全局限制（"a context-global restriction would mask every agent"）。配置单挂载层即 Agent 作用域，preset 行插件调用 restrict 天然 per-Agent 生效。
6. **子代理继承配置单**：子代理创建时经 `composeFrom` 加入父会话的配置单（读父的 live scope 而非 header）；`SpawnTeammateRequest`（name/description/prompt/context: fresh|fork/provider/signal）**不含 preset 字段**——队员装备跟随队长，角色差异由任务书与目录规则表达。
7. **官方配置单在闭包内不可变**：闭包指纹锁定（见「DSH home 与运行时隔离」），定制官方配置单的唯一正路是 copy 到用户根改副本。

---

## 设计约束

> 以下约束定义生产边界。实现可以调整内部结构，但依赖方向、发布边界、版本确定性、启动语义与数据隔离的变化必须先更新本设计并重新确认。约束按编号列表组织，交叉引用使用「设计约束 · <标题>」。

1. **cordis import 边界**：`@deepseek-ai/cordis` 的类型与运行时适配只出现在 `@wopal/ellamaka-cordis` 包内。生产运行时值经 installAnchor resolver 从物化闭包获取。
2. **DSH 依赖真相源**：`ellamaka-cordis` 的 `dependencies` 只显式声明 Bridge 使用的官方直接依赖，并使用精确版本。构建生成的 `dsh-runtime-manifest.json` 携带直接依赖精确版本，`dsh-runtime-lock.json` 携带完整传递依赖树与 integrity；运行时不维护第二份手工清单，也不在运行时解析依赖树。
3. **dsh 深耦合包暂缓使用**：agent-loop/session/session-query/compaction/subagent/schedule 及任何 rt-import dsh-session 的包，暂不被主线代码 import、不在运行时加载、不作为插件挂载。required peer 进入 node_modules/bun.lock 仅供类型解析。运行时加载探针（`forbidden-load.test.ts`）作为当前状态的观测手段保留。
4. **session 所有权**：持久化与事件定义归 Storage/Bus/EventV2；Cordis 层只持有 facade。
5. **对外契约稳定**：SSE 事件、HttpApi、SDK 在融合中保持稳定。
6. **桥接的加法原则**：桥接优先为新增文件/包装层，保持删除桥即回滚的能力。
7. **wopal-plugin 原生边界**：wopal-plugin 继续作为 ellamaka 原生插件运行。只采用独立 dsh 能力，不拆分或迁移 wopal-plugin。
8. **工具容器边界**：工具调用走专用工具容器（ellamaka-tools profile），容器内不创建任何 dsh session；adapter 只传递工具实测消费的最小 per-call context。web 容器保持完整 profile，不复用为工具后端。禁用清单是 profile 的用户补丁层，ellamaka 仅在模板为空时播种、不覆盖用户编辑。
9. **空间隔离**：容器装配是进程级共享能力池，空间差异在投影层解决。
10. **DSH home 唯一**：依赖闭包、profile 定义与运行时数据只物化在 `$WOPAL_HOME/dsh`；ellamaka 集成永远只用 `$WOPAL_HOME` 解析自己的路径。宿主在进程启动时设置 `DSH_HOME=$WOPAL_HOME/dsh/home`（dev.sh 与 Desktop sidecar），`home/` 是 100% 官方布局的 harness home（见「唯一 home 与目录所有权」）；集成代码自身不读该 env。`~/.dsh` 归 dsh 官方 CLI 独立试验专用，ellamaka 不在其内创建、修改或删除任何内容。
11. **启用开关统一**：`ELLAMAKA_DSH` 是禁用开关，默认开启。serve、web、TUI 与 Desktop sidecar 统一以 `ELLAMAKA_DSH=0` 禁用，未设置或 `!=0` 启用。无其他分支启用方式。
12. **运行时隔离**：dsh 运行时数据落 `$WOPAL_HOME/dsh/home/`（DSH_HOME）内官方语义位置（sessions/settings/credentials 等），与闭包、plugins 分目录。A 类插件经 config 注入、B 类官方包经 env 直读，两条路汇合同一 home，官方包永不落到 `~/.dsh`。
13. **交付边界**：Ellamaka 发布物携带编译后的 Bridge；`@deepseek-ai/*` 官方运行时只存在于指纹闭包。Bridge 不发布为独立 registry 包，也不进入闭包 manifest。
14. **版本绑定**：DSH 运行时清单与 Ellamaka 发布版本绑定。普通配置不覆盖 DSH 版本；独立升级通过发布经过验证的完整清单完成。
15. **统一自物化**：Runtime Manager 是所有入口的唯一物化实现。闭包缺失或损坏会触发自动物化，不等价于用户禁用，也不要求用户运行脚本修复。
16. **不可变闭包**：每份完整依赖树按清单指纹落入独立 generation。升级创建新 generation，运行进程持续使用启动时捕获的 installAnchor。
17. **插件安装共享、启用按 profile**：安装区（`plugins/`）进程内唯一，安装/升级/卸载全局一次；激活经 profile bundles 清单按容器声明。同一进程内不做同包双版本 skew。
18. **插件安装零外部工具链**：安装器不 forward 系统包管理器（pnpm/npm），复用 Runtime Manager 的 pacote + registry 测速基建；用户插件的传递树由内置最小解析器在运行时解析（见「已验证事实 · 插件供应链实测事实」）。
19. **安装命令式、配置双轨**：插件安装与 dsh 界面侧的插件配置走命令式并即时生效；集成到 ellamaka 的工具投影配置走 settings.jsonc（与「配置与隔离 · 进程级共享、空间级隔离」一致）。
20. **approval 原生边界**：dsh approval 插件以官方原版使用（不 fork、不修改官方闭包）。宿主侧只补齐 session facade 前置条件并经 answerer 桥接决策；审批审计对落内存不落盘，工具容器不持久化任何会话。
21. **Bun 宿主兼容性门禁**：发布态 `ellamaka serve` 是单 Bun 进程；用户插件不得要求 Node 私有模块加载器或 `--expose-internals`。`plugin add` 必须在写入 profile 声明与触碰运行中容器前完成静态依赖扫描与 Bun 隔离挂载预检；不兼容插件拒绝安装并给出可操作诊断，绝不以伪造 `loader.internal`、切换到 Node 或降级整台宿主来绕过。官方 Node 专用 `cordis-plugin-hmr` 是宿主实现例外：Bun 路径以 Bridge 的 Bun HMR 适配器替代它，不把该例外转嫁给第三方插件。
22. **多空间解耦与实验 profile 隔离**（见「多空间解耦与实验 profile」）：核心容器（web + ellamaka-tools）保持同进程；实验性第三方 profile 以独立进程 + 独立 DSH_HOME 运行，不进入主 Web 容器、不与主引擎共享 home/profiles（运行中引擎 `profiles/` 是引擎领地）。闭包（只读）可共享；home 必须隔离。实验 profile 的插件安装长期形态走 A2 官方声明供应链。
23. **壳单端口不变量**（见「壳单端口化与 workbench 精简」）：renderer 永远加载唯一 http origin（server 端口）上的 UI；壳不承载引擎逻辑，不出现第二个为壳服务的监听端口。引擎产物只有一个形态——完整 CLI 二进制；禁止维护第二套分叉的引擎构建产物（sidecar 构建链是 Bun 兼容收敛前的 Phase 1 例外，收敛后退役）。`/dsh` 保持前缀挂载不升根，`/` 是设备协商前门（移动 UA → `/dsh/`，桌面 UA → `/workbench`）。

---

## 生产物化验收基线

> 已于 2026-09-01（P5 批次）全部达成，进入维护态。

| # | 能力 | 验收结果 |
|---|------|----------|
| 1 | 发布边界 | CLI 与 Desktop sidecar 包含已编译 Bridge；发布物不包含 DSH 官方包源码；闭包 manifest 不包含 `@wopal/ellamaka-cordis` 或 `file:` 依赖 |
| 2 | 清单生成 | 构建从 `ellamaka-cordis/package.json` 生成 `dsh-runtime-manifest.json`，并解析出内嵌锁 `dsh-runtime-lock.json`；CI 检测源、清单与锁的漂移 |
| 3 | 版本确定性 | 同一 Ellamaka 发布物在不同机器上使用相同直接版本、传递锁树与 integrity；运行时从不查询 `latest`，也不在运行时解析依赖树 |
| 4 | 入口一致性 | serve、web、TUI 与 Desktop sidecar 默认自动物化；Workbench 由承载它的后端完成物化；`ELLAMAKA_DSH=0` 是唯一跳过路径 |
| 5 | 单一实现 | 所有入口调用同一个 Runtime Manager；不存在 Desktop 复制版物化器或需要用户运行的物化脚本 |
| 6 | 并发与原子性 | 多进程共享 `$WOPAL_HOME` 时只执行一次下载；未验证 staging 不参与加载；升级不改写运行中的闭包；闭包只增不减、无自动删除 |
| 7 | 动态加载 | Bridge 仅从 installAnchor 对应闭包加载官方运行时；应用 bundle、cwd、workspace 和全局 node_modules 不影响解析 |
| 8 | 失败语义 | 首次安装、升级、离线、超时、integrity 失败与损坏闭包均产生确定的状态和诊断；Ellamaka 能以无 DSH 模式继续运行 |
| 9 | 隔离 | 依赖闭包、home 与 plugins 各归其位；Ellamaka 不读写 `~/.dsh`；`DSH_HOME` env 由宿主设置为 `home/`（官方包 env 直读汇合点），集成代码不消费它 |
| 10 | PoC 机制退出 | 生产链路不再使用 TS strip-types、`.js → .ts` loader、`resources/dsh-materialize/cordis` 源码副本及手工版本常量 |

---

## 插件供应链

> 2026-09-05 生态对齐定稿：插件安装/注册/组合全面对齐官方生态契约，执行器换成 Bun（零 pnpm、零官方 dsh CLI 依赖）。对齐原则：**凡是官方生态有既定机制的，声明与终态对齐官方，不自研平行路**。

### 定位与原则

dsh 插件是 ellamaka 的一等公民：**命令式安装、即时生效、跨重启保留**。插件生态的通用语言是 profile 目录的声明文件（`package.json` 的 `dependencies` + `dsh.profile.bundles`、`cordis.patch.yml`）——官方 CLI、dshmarket、热挂载、快照回滚全部构建在这组文件上。Ellamaka 引擎的 `loadProfile` 本就消费这套文件，官方机制装出的插件无需任何适配即被加载。

三条原则：

1. **生态契约对齐**：安装的终态 = 官方语义的 profile 目录（依赖声明 + bundles 注册 + 可解析的 node_modules）。所有生态参与方（官方 CLI、市场、宿主引擎）读写同一套声明文件。
2. **执行器 Bun 化**：pnpm 只是官方 CLI 选择的安装执行器，不是生态契约。Ellamaka 以 Bun 生态实现安装（自研解析器 + pacote 下载 + node_modules 摆放），用户机器零 pnpm 依赖。
3. **闭包分层**：官方闭包保持不可变；插件依赖 `@deepseek-ai/*` 时经共享层 symlink 解析到闭包（heal 机制），与引擎运行时版本天然一致。

### 真相源与目录布局

**profile `package.json` 是插件安装的唯一真相源**（dependencies 记录已装包与版本，`dsh.profile.bundles` 记录激活的插件层）。`cordis.patch.yml` 是用户补丁层（禁用/覆盖/表达式）。`installed.json` store 退役。

```text
$DSH_HOME/profiles/
├── node_modules/                ← 宿主共享依赖层：@deepseek-ai/* 官方包 symlink 到闭包（heal 维护）
└── web/
    ├── package.json             ← dependencies（已装清单）+ dsh.profile.bundles（激活清单）＝ 真相源
    ├── node_modules/            ← 插件实体 + 传递依赖（Bun 安装器摆放，Node parent-walk 可解析）
    ├── cordis.yml  cordis.patch.yml
    └── .dsh-market/             ← 市场状态（装了市场后由市场自管）
```

组合顺序：bundle 层（`dsh.profile.bundles` 逐包应用各自 `cordis.patch.yml`）→ 用户补丁层 → Bridge extra patches → home patches。官方 CLI 的 `dsh plugin add`、市场的安装、Ellamaka 的 `ellamaka dsh plugin add` 写的都是同一套文件。

### `ellamaka dsh` shim 命令面

`ellamaka dsh` 是官方 `dsh` CLI 的 Bun 执行器替身，命令面严格复刻官方形状（参数位置、flag 名称、互斥与报错语义），执行仍用自家 Bun 安装器与 profile manifest 真相源。`alias dsh='ellamaka dsh'` 后官方命令形状可直接使用：

```sh
# plugin 管理（官方序：--profile 是 plugin 子命令自有 option，可置于动词前后；省略回退默认 web,ellamaka-tools）
ellamaka dsh plugin --profile web add <pkg>[@version]    # 官方动词，Bun 安装器执行，写官方终态
ellamaka dsh plugin --profile web add ./my-plugin        # 官方 path spec：./ ../ / . 操作数从本地目录安装（--dir 已退役）
ellamaka dsh plugin --profile web remove <pkg>           # 官方动词
ellamaka dsh plugin --profile web install                # 官方动词：按 package.json 全量重装（市场恢复流程依赖）
ellamaka dsh plugin add <pkg>                            # 省略 --profile：回退默认 web,ellamaka-tools（A2 兼容）
ellamaka dsh plugin --profile web,tools add <pkg>        # 多值逗号 profile 是 ellamaka 扩展（官方单值的超集）
ellamaka dsh plugin --profile web enable/disable <pkg>   # ellamaka 扩展动词（写用户补丁层）
ellamaka dsh plugin --profile web list [--json]          # ellamaka 扩展动词

# 配置转储（官方序：根 flags 在 dsh 根解析；--patch repeatable、argv 序、缺失文件 throw）
ellamaka dsh --dump-config --profile web [--patch a.yml --patch b.yml]
ellamaka dsh --dump-default-config --profile web         # 仅 bundle 层；拒绝 --patch；与 --dump-config 互斥
ellamaka dsh dump-config --profile web [--default-only] [--patch ...]   # ellamaka 兼容扩展子命令（B1.5）；输出为渲染 YAML，与官方形态一致（--json 已退役）
```

官方语义对齐要点：根 flags（`--profile`/`--patch`/`--dump-config`/`--dump-default-config`）出现在 `plugin` 子命令之前时报错（官方 rejectParentOptions）；未知 plugin 动词（官方 `why` 等 pnpm 动词）不转发，明确报错——`pnpm why` 依赖 pnpm lockfile/持久化依赖图回答「包为何被安装」，ellamaka 真相源只有 profile 直接依赖声明，无对应语义；安装时持久化解析树后可做等价实现。`--patch` overlay 缺失文件即配置错误 throw（官方 loadOverlayPatches 语义）。boot 模式（`dsh --profile <name> "args"`）与 `dsh web` 别名不 shim——`ellamaka serve` 就是宿主，命令面报错提示 serve。安装即时生效由 Bridge 的组合文件监听驱动（并入 B2 bun-hmr 的 `registerConfig` 范围），补足官方“首次安装需重启”的缺口。

### Bun 安装器流水线

```text
解析 spec → BFS 解析传递树（abridged packument + semver，复用自研解析器）
        → pacote 逐包下载解压（复用物化器 registry 测速基建）
        → 摆放：entry 包 + 传递依赖落 profiles/<name>/node_modules/（parent-walk 可解析）
        → 共享层 heal：@deepseek-ai/* symlink 到闭包，保证 hasLoadableEntry 类校验命中
        → 声明落盘：写 dependencies + 追加 dsh.profile.bundles（与官方 CLI reconcilePlugins 同语义）
        → 组合校验：复用闭包官方模块（app-boot 的 initProfile/loadProfile 显式 home 参数）
        → 运行中容器热挂载（组合文件监听触发，同官方 include 机制）
```

- **peer dependency 处理**：peer 依赖不下载、不摆放。官方生态插件的 peer（`@deepseek-ai/cordis`、`@deepseek-ai/dsh-settings`、`@deepseek-ai/schemastery` 等）由共享层 heal 的 `profiles/node_modules/@deepseek-ai/*` symlink 满足——插件 `node_modules/` 向上 parent-walk 找到共享层即命中。Bun 安装器只下载 `dependencies` 的传递树，peer 解析交给运行时 parent-walk。闭包版本与 peer 版本范围的匹配在安装器的组合校验步骤确认（`hasLoadableEntry` 通过 = peer 可达）。
- **失败语义**：解析/下载失败不触碰 profile 目录；半安装状态只存在于 staging 临时目录。
- **并发**：`locks/plugins.lock` 跨进程锁串行化写操作。
- **Bun 宿主兼容性预检**（D-06 保留）：静态 Node 私有 loader 扫描 + 隔离挂载，在落盘前执行。
- **GitHub 源**（`github:owner/repo`）：第二期实现（git clone + bun build）；第一期给明确报错与 npm 替代指引。第一期排除理由：(1) 技术面——安装器 resolver 是 registry-only 最小实现，git 源需要 clone + prepare 脚本构建的完整第二条管道（官方 pnpm 在此也要求用户手动 allowBuilds，闭包 `plugin-*.js`）；(2) 供应链面——registry-only 保证每个安装产物有 registry 身份、精确版本与来源可审计，git spec 是任意可变代码 + 安装期执行构建脚本，攻击面不同。同批拒绝的还有 `file:`/`link:`/`tarball:`/`https?:`；本地目录安装走 add 的 path spec 操作数（`add ./dir`，官方 pnpm 语义）这条显式通道。

### 与 dshmarket 的宿主安装工契约

市场插件内置两种安装执行方式：spawn 宿主 CLI（读 `process.argv[1]`，在 Bun 打包的 serve 进程下语义失效）或**宿主安装工契约**——宿主在容器内注册 `desktopProfiles`（当前 profile 名与目录）与 `desktopPnpm`（安装执行接口）两个 service，市场即完全通过注入接口执行安装/卸载/恢复，不 spawn 进程。官方 DSH Desktop 正是此模式的先例。

Ellamaka 容器常驻注入这两个 service；`desktopPnpm.runPlugin(args, dir, signal)` 的实现 = Bun 安装器（支持 `add`/`remove`/`install` 三个动词，exitCode 0 即成功；pnpm ndjson 进度事件为可选增强，缺省退化为普通进度显示）。市场的目录浏览、一键安装、更新、快照、热禁用全部原生工作，零修改市场代码。

**已知偏差**：市场的更新自动回滚按 `pnpm-lock.yaml` 字节恢复执行；Bun 安装器不产 pnpm-lock，回滚退化为按快照 `package.json` 声明重装（语义等价，非字节级）。市场快照本身只存 `package.json`、`cordis.patch.yml`、`.dsh-market/state.json`，不含 lock。

**自重启边界**：市场 `restart.ts` 可 SIGTERM 宿主进程。Ellamaka 以 `allowRestart: false` 注入关闭此路径，容器进程生命周期归用户。

### 实现决策

- **D-01**：容器完整补丁栈 = bundle layers（profile `dsh.profile.bundles`）→ 用户补丁层 → Bridge extra patches → home patches，逐层覆盖。
- **D-02**：热挂载触发 = 监听 profile 组合文件（package.json / cordis.patch.yml）变化；CLI 与市场安装都是纯磁盘操作 + 触发组合事件；由 B2 bun-hmr 的 `registerConfig` 承载。
- **D-03**：include `entry.update()` 重放契约——按 entry id diff 事务性插拔，浅合并（更新 patches 先展开旧 config）。
- **D-04**：profile `package.json` 是插件安装唯一真相源；官方 CLI 与市场与 `ellamaka dsh plugin` 写同一套文件；无第二清单。
- **D-05**：共享层 heal——`profiles/node_modules` 的 `@deepseek-ai/*` symlink 指向闭包（官方包解析归口），安装/启动时幂等维护。
- **D-06**：Bun 宿主兼容性门禁——下载后的 staging 先做 Node 私有 loader 静态扫描，再做隔离 Cordis 挂载；任一失败都不可落盘或触碰正式容器。
- **D-07**：`desktopPnpm` 实现支持 `add`/`remove`/`install` 三动词；`add` 接受 npm 包名、`name@version` 与 `--dir` 本地路径；exitCode 0 即成功语义。

### 配置与信任

- **配置双轨**：工具投影侧（插件的工具是否投影进 ellamaka、白名单）走空间级 `settings.jsonc`；dsh 界面侧（entry 级配置）命令式写补丁层，动态生效。
- **信任边界**：命令式安装是用户显式动作，做 tarball integrity 校验；第三方插件与宿主同进程执行的风险在安装输出中明示。不新造权限体系。

### 迁移路径

1. 布局迁移：`state/*` → `home/`，`profiles/` → `home/profiles/`，`.agent-presets` → `home/.agent-presets`；`state/` 退役（引擎停止后一次性执行）。
2. env 注入改指 `home/`：dev.sh 与 Desktop sidecar。
3. 安装器 retarget：从 `plugins/<pkg>/<ver>/` + store 改写为 profile node_modules + package.json 声明；`installed.json`/`composePluginLayers` 退役。
4. 宿主安装工契约：`desktopProfiles` + `desktopPnpm` 注入实现。
5. 已装 poc 插件（hello、weapon-rack 等）迁移到官方声明形态。
6. 回归验收：preset 发现、市场安装流、官方 CLI 同 home 互操作、插件热挂载、dump-config。

### 验收基线

| # | 能力 | 验收结果 |
|---|------|----------|
| 1 | 生态互操作 | 官方 `dsh plugin`（指到同一 home）与 `ellamaka dsh plugin` 装的插件彼此可见，引擎都能加载 |
| 2 | 市场全流程 | dshmarket 在 Ellamaka 容器内完成浏览→安装→启用→禁用→更新，全程 Bun 执行器、零 pnpm |
| 3 | 即时生效 | 安装后运行中容器免重启生效（组合文件监听 + include 重放） |
| 4 | 持久化 | 重启后已装清单与激活状态一致；profile package.json 是唯一真相源 |
| 5 | 失败语义 | 解析/下载/预检失败不触碰 profile 目录与运行容器；有可诊断输出 |
| 6 | 共享层一致 | `profiles/node_modules` 的官方包 symlink 恒指闭包，引擎与生态校验共享同一解析 |
| 7 | Bun 预检 | Node 私有 loader 依赖在落盘前被拒绝，输出命中证据 |

---

## wopal 插件包（Agent 配置随包发布，当前主线）

> 设计定稿（2026-09-03）；**2026-09-05 生态对齐后修订**。目标：wopal 的灵魂与能力以 **dsh 官方插件形态**交付——一个可发布到 dsh 生态的完整插件包（内含配置单 + 自定义能力），用户安装即得 wopal 配置单。机制事实依据见「已验证事实 · Agent 配置体系机制事实」。
>
> **修订要点（相对 2026-09-03 定稿）**：废弃「预设生成器」（每空间 × 每灵魂自动生成配置单）。配置单是全局一份的装配清单（不是每空间生成物），且 ellamaka 灵魂与 dsh 配置单是两种语言，只能按相似设计意图人工适配，不能自动生成。配置单的交付形态改为**随插件包发布**——与官方 `dsh-agent-presets` 包内置 shipped presets 同构。

### 定位

主战场是 **dsh 界面本身**（助理 tab 的原生 UI + 官方引擎）。ellamaka 侧已定稿不再扩展，只通过工具容器继续喂小工具（见「能力采用」）。本节把 ellamaka 已验证的「空间 = 能力集 + 灵魂团队 + 权限控武器」模式，以 **dsh 官方插件规范**交付——wopal（及其团队 fae/rook）是一个标准 npm 插件包，配置单与自定义能力随包发布，安装即得。

两个组成件，全部踩在官方生态契约上：

| 组成件 | 解决的问题 | 依赖的地基 |
|--------|-----------|-----------|
| **wopal 插件包** | 配置单随包发布（安装即得 wopal/fae/rook 配置单）+ 打包自定义能力 | 官方 agent-presets 双根机制 + `config.roots` 通道 + 生态对齐供应链（E2） |
| **武器架能力** | 队员武器可见性 + 上下文 token 成本 | 引擎 `tools.restrict`（Agent 配置体系机制事实第 5 条），作为包内插件能力 |

组队不新建机制，直接采用 dsh 官方组队能力（见「组队语义」）。空间皮肤插件（S3）保持独立后续项（见 PLAN-TODOS）。

### 概念映射

| wopal 资产 | dsh 机制 | 插件包动作 |
|------------|---------|-----------|
| 灵魂（wopal/fae/rook 人格） | 配置单 persona | 人工适配为配置单（按相似设计意图，非自动生成），随包发布 |
| 工具可见性（权限控武器） | 武器架能力（`tools.restrict`）+ 配置单 allow 名单 | 包内 `lib/weapon-rack.js`，配置单一行引用 |
| `.wopal/skills/`（wopal 专属技能） | 配置单 `skill-filesystem.customSkillDirs` | 指向空间技能目录（绝对路径，安装时按空间实例化） |
| 空间 `AGENTS.md` / REGULATIONS | 引擎 agent-instructions 按会话 cwd 向上逐层读取 | **无需打包**——按目录自动生效 |
| 灵魂间协作规则 | 官方组队工具行 + 人格内协作纪律 | 配置单组队工具行 + 人格段落 |
| 自定义能力（未来） | 包内插件（apply 注册工具/服务） | 与 presets 同包发布，配置单引用 |

**关键边界——安装共享、可见性按配置单**：dsh 插件安装是进程级全局动作（「设计约束 · 插件安装共享、启用按 profile」既定）；"wopal 有而别的配置单没有"的表达层是**配置单的插件行 + 武器架 allow 名单**，不是每配置单一套安装区。这与既有的「安装共享、启用按 profile」同构，可见性粒度从 profile 细化到配置单。

### wopal 插件包（配置单随包发布）

wopal（及团队 fae/rook）以**标准 dsh 插件包**交付，与官方 `dsh-agent-presets` 包内置 shipped presets 同构：

```text
@wopal/dsh-wopal-pack/
├── package.json              # main/exports；files 含 lib/ 与 presets/
├── lib/
│   ├── index.js              # 插件 apply(ctx)：注册武器架能力等
│   └── weapon-rack.js        # tools.restrict 逻辑（配置单引用的能力件）
├── presets/                  # 随包发布的配置单（与官方 shipped presets 同构）
│   ├── wopal/                #   agent.cordis.yml + preset.yml + skills/
│   ├── fae/
│   └── rook/
└── cordis.patch.yml          # 声明：向 agent-presets 行追加 config.roots
```

- **安装链路（全官方生态，零自研）**：`ellamaka dsh plugin add @wopal/dsh-wopal-pack`（E2 Bun 安装器）→ 包实体进 `home/profiles/<profile>/node_modules/`、`package.json` 声明 dependencies + bundles → 包的 `cordis.patch.yml` 向 agent-presets 行追加 `config.roots`（指向包内 `presets/`，官方预留的 deployment-added roots 通道）→ 引擎 discoverPresets 扫到 wopal/fae/rook → 配置单列表出现。
- **配置单根语义**：包内 `presets/` 以 `{ path, trust: "system" }` 注册，与官方 `includeShippedRoot` 同机制（区别仅根来源是已装插件包而非官方包）。用户个性化仍走官方 authoring 路径 copy 到 `home/.agent-presets/`（用户根，升级不丢）。
- **规范符合性**：插件实体/注册/组合 = 官方 profile 声明文件（生态对齐 E2）；配置单根 = 官方 `config.roots` 通道；preset 随包发布 = 官方 `dsh-agent-presets` 先例；能力 = 普通 cordis 插件（`ctx.tools.register`/`restrict`）。

### 武器架能力（包内插件）

wopal 配置单引用的一个能力件（包内 `lib/weapon-rack.js`），按需在配置单行挂载：

- **行为**：挂载时读取自身配置 `{ allow: [toolName...] }`，对当前 Agent 作用域调用一次 `ctx.tools.restrict({ allow })`。
- **效果**：不在 allow 名单内的工具从该 Agent 的模型视野中完全移除——工具 schema 不下发，对应 prompt token 一并消失。同时解决两个问题：**队员不必承接主 Agent 全部武器**（ellamaka 权限体系控可见性的对等语义）与 **token 成本**（描述文本不再占用上下文）。
- **作用域正确性**：配置单挂载层即 Agent 作用域（引擎强制拒绝无作用域的全局限制），preset 行插件调用 restrict 天然只影响加入该配置单的 Agent。
- **分发**：随 wopal 插件包发布（`lib/`），配置单以一行插件行 + 各自 allow 名单引用。若未来被其它配置单复用，可拆为独立包。

### 空间皮肤插件

一个 dsh 插件（服务端 + 客户端两半），实现「界面按空间定制」：

- **空间识别**：服务端从当前会话的 cwd 反查所属空间——dsh Web 容器的会话按空间目录建立（`provisionSpace`），空间目录带 `.wopal-space/` 标记，纯 fs 判断，不依赖跨引擎调用（见「设计决策 · 空间识别用会话工作目录」）。
- **数据通道**：服务端经 `ctx.webServer.register` 在 `/dsh/*` 下暴露该空间的皮肤配置（主题 token 覆盖、界面件开关、品牌资源）；客户端同源 fetch（「运行时机制 · 浏览器前缀适配」同源适配下天然可用）。
- **界面件**：客户端按配置应用主题 token 与声明式 slots——brand 位（空间名/标识）、composer 上下 dock 条（空间专属常驻信息条）、会话头部动作位（空间专属操作入口）、自定义工具的对话卡片（`tool.call.toolview` 按工具名 key）。
- **风格一致性**：主题 token 对齐 workbench 设计语言；皮肤件与 workbench 共享同一套品牌资源。

### 组队语义

直接采用 dsh 官方组队能力，不新建机制：

- **招人**：主 Agent 运行时经 `subagent`（独立小弟）/ `subagent_fork`（带上下文分身）/ Agent Teams（正式编队，成员互发消息、领任务）招人；大规模并行用 `workflow`。
- **队员装备**：队员自动加入队长的配置单——继承队长的武器、技能与空间规则（cwd 同源），天然"知道这个空间的守则"。角色差异由**任务书**（spawn 的 name/description/prompt，即灵魂定义的职责部分）与**目录规则**表达。
- **协作纪律**：消息往来、任务分派、完成上报是引擎内建能力；协作规范（如 wopal 的 agents-collab 约定）写入主 Agent 人格。
- **per-角色武器装备**（不同队员带不同工具集）：官方招人接口不含 preset 字段，需自定义招人 provider（引擎 `registerProvider` 扩展点）按角色挂载不同配置单。这是条件触发项——第一阶段任务书 + 目录规则已覆盖角色分化的主要诉求，只有当"队员必须带不同武器"成为真实需求时才立项（见「设计决策 · 组队用官方机制」）。

### 设计决策

| 决策 | 内容 | 理由 |
|------|------|------|
| **配置单随包发布** | wopal/fae/rook 配置单随插件包发布，经官方 `config.roots` 通道注册为 system 根 | 与官方 `dsh-agent-presets` 同构；安装即得；升级包即升级配置单 |
| **不自动生成** | 废弃「预设生成器」；配置单由人工按相似设计意图适配 | ellamaka 灵魂与 dsh 配置单是两种语言，无可靠自动映射（用户裁定） |
| **个性化走用户根** | 用户对 wopal 配置单的个性化经官方 authoring 路径 copy 到 `home/.agent-presets/` | 升级包不覆盖用户个性化；官方 authoring 通道 |
| **武器可见性 = per-Agent 白名单** | 角色武器差异统一走武器架能力（`tools.restrict`），不用补丁层或安装区表达 | 引擎级语义正确（从视野移除）；token 成本同步解决 |
| **界面定制只走声明式 slots/theme** | 皮肤插件禁用 replace 整区（shadows-shipped-ui 高风险位） | 未来 iframe → 原生演进（待定事项）时定制件可迁移 |
| **空间识别用会话工作目录** | 皮肤插件与服务端以 cwd + 空间目录标记判断，不新增会话字段、不做跨引擎 RPC | 最小耦合；dsh 会话本就按空间目录建立 |
| **组队用官方机制** | 自定义招人 provider 仅在 per-角色武器成为真实需求后立项 | 队员继承配置单已覆盖主要诉求；避免过早建设 |

### 验收基线

演进步骤与批次管理见 `PLAN-TODOS.md` 当前主线（小步推进，每步有可应用成果）。本节只定验收终点：

| 验收项 | 判据 |
|--------|------|
| 随包发布 | `ellamaka dsh plugin add @wopal/dsh-wopal-pack` 后 wopal/fae/rook 配置单出现在配置单列表，安装即得 |
| 规范符合 | 包实体进 profile 官方终态（node_modules + package.json 声明）；无自研安装/注册机制 |
| 武器可见性 | 不同配置单的会话模型视野工具集与 allow 名单一致；token 占用随名单收窄 |
| 技能与规则 | 空间技能目录加载；AGENTS.md 规则按 cwd 生效 |
| 界面形态 | 编码/多媒体两演示空间视觉可区分；皮肤件崩溃被错误隔离，不影响宿主 |
| 组队 | 队员继承队长配置单与空间规则；任务书角色分化生效 |

---

## Bun 宿主 HMR 与闭包升级（当前主线）

> 设计定稿（2026-09-03）；**2026-09-05 按 B3（闭包 0.1.2-rc.1 实机升级）实证修订**。背景：官方 0.1.1-rc.2 运行中发生三类事故——tool-cordis 进程级注册冲突、29.9 万事件大会话回放拖垮单进程控制面、state 目录被官方 CLI 污染。官方 0.1.2-rc.1 已将模块级 HMR 改为按 profile 显式启用（base bundle 默认 `hmr: disabled: true`）；闭包已随 B3 升级（提交 `5e587e8b2c`）。本节给出 Bun 宿主下 DSH 热加载能力的完整设计与升级路径。机制事实依据见「已验证事实」与本节内联引用；B3 之后新增以 rc.1 闭包实机代码为准（`~/.wopal/dsh/closures/<fingerprint>/node_modules/@deepseek-ai/*`），不再以 ref-repo 源码推演。

### 官方 0.1.2-rc.1 机制事实

以下事实逐条核对自 `labs/ref-repos/deepseek-harness`（0.1.2-rc.1 tag）：

- **模块级 HMR 是 opt-in**：`packages/bundle/base/cordis.patch.yml` 中 `hmr` 行带 `disabled: true`，注释「Module reload is opt-in per profile」。官方唯一调用方是 CLI TUI 开发路径。
- **watch-only 回退是 Node-only**（B3 实机修订）：`profile-boot`（闭包 `dsh/lib/profile-boot-*.js:271-288`）对 `patchReload: 'live'` 的 profile（web 模板默认 live）在 `hmr` 未挂载时以 `config: { root: [] }` 挂载空根 HMR 实例，仅提供 `registerConfig` 配置监听。但该创建路径在 Bun 下**第一步就抛错**——官方 hmr 插件构造器要求 `loader.internal`（见下条），异常被 `try/catch + suppressShutdownError` 静默吞掉。结论：**Bun serve 下用户 patch 热加载在 rc.1 官方代码中完全不可用**（watch-only 回退与模块热换一样失效），bun-hmr 是 Bun 下该能力的唯一路径，B2 的验收基线是 0 → 1。
- **HMR 的 Node 私有依赖仍在**：`cordis-plugin-hmr/lib/index.js:107` 构造器要求 `ctx.loader.internal` 存在（"–-expose-internals is required for HMR service"），模块热换路径使用 Node 内部 ESM loader 的 `loadCache`/`resolve`（`:216`）。Bun 下该条件永远不成立（`ModuleLoader.fromInternal()` 只识别 Node ≥22 的 internal/modules/esm/loader）。
- **loader 无 internals 时的降级是官方语义**：`vendor/loader/src/index.ts:73` 中 `internal = ModuleLoader.fromInternal()` 可为 `undefined`；裸包名导入走原生 `import()`（`vendor/loader/src/config/tree.ts`）。官方 embedder 文档明确「无 internals 走 documented no-internals path」。
- **tool-cordis 注册表冲突未修**：`packages/extensions/cordis-host-runner/src/inspect-registry.ts` 的 `register()` 依旧按 manifest id 全局去重抛错；同引擎第二个含 `tool-cordis` 的 preset 挂载仍失败。
- **FrameQueue 仍无界**：`packages/host/apiproxy/lib/index.js` 的 `FrameQueue.push` 依旧无条件 `buffer.push`，无帧数/字节上限。
- **agent-loop 仍逐 delta 事件**：`packages/core/agent-loop/src/agent.ts:368` 依旧 `session.append('assistant/chunk', ...)` 逐 delta 持久化；存储层 `packChunkRuns` 打包发生在写入时，运行时事件数不变。

### Bun 宿主 HMR 适配器（bun-hmr）

**定位**：Bun 容器内实现官方「配置热加载」契约；模块级热换降级为安全的事务性重载。适配器以 `@wopal/ellamaka-cordis/bun-hmr` 提供，在 Bun 路径以同一 `hmr` 服务位替代官方插件。Node 路径按能力选择：仅当运行时 Loader 实际公开 `internal` 时才使用官方 `@deepseek-ai/cordis-plugin-hmr`；打包 Electron utility sidecar 缺少该能力时同样回退到适配器，避免官方构造器让整个 profile 挂载失败。

**兼容契约（B3 实证收窄）**：官方调用方 `watchUserPatches`（闭包 `dsh-app-boot/lib/index.js:1075-1095`）对 `hmr` 服务位的消费面**精确两个方法**——`registerConfig(filename, refresh)`（监听单文件、变更时串行 refresh、返回 disposer；重复注册同路径抛错）与经 `entry.update({ config: { patches } })` 的组合重放。refresh 闭包由官方提供（重读 patch 文件 → `compose` → `entry.update`），bun-hmr 只负责「检测变更 + 串行调度」。因此 bun-hmr 不需要复刻官方 hmr 的模块根/watcher 配置面：官方 `watchUserPatches` 以 `config: { root: [] }`（空根）挂载，语义就是「无模块监听、只要配置监听」；构造器守卫（`loader.internal`）在 bun-hmr 中不存在。错误契约对齐：`registerConfig` 在服务未激活时抛错、官方调用方对 `INACTIVE_EFFECT` 错误码静默降级为 no-op disposer——bun-hmr 保持同样的错误形状。实现时以 rc.1 闭包 `cordis-plugin-hmr/lib/index.js` 的 `registerConfig` 为对齐基准（`findWatchRoot`、路径去重、串行 refresh），不参考 rc.2 时代设计稿。

**能力边界**（对照官方 hmr 的两个消费者）：

| 能力 | 官方语义 | bun-hmr 语义 |
|------|---------|-------------|
| `registerConfig(filename, refresh)` | 监听单文件，变更时串行执行 refresh | 原样实现（chokidar watch，行为等价） |
| 模块根监听（`root: [dirs]`） | 追 Node 模块图、清缓存、按依赖分析热换插件 | 不支持；候选 import 校验 + fiber 原子替换（见下） |
| `loader.exit()` 兜底 | 依赖树变化触发宿主重启 | 同语义：闭包级依赖变更由 Runtime Manager 走新闭包 generation |

**模块热换的 Bun 替代路径（generation 原子替换）**：

1. 插件或 profile patch 变更 → Bridge 组合完整候选补丁栈（现有 `startDshPluginService` 的组合逻辑）。
2. 候选栈在隔离 Cordis context 中加载并激活校验（复用「插件供应链 · Bun 宿主兼容性预检」的隔离挂载实现）。
3. 校验通过后等待该容器无进行中 agent 请求（空闲窗口），事务性执行 `includeEntry.update()`——由官方 Loader 按 entry id 插拔 fiber，失败自动回滚旧栈。
4. Bun 模块缓存不需要清除：隔离候选使用内容寻址 URL（`file://...?<content-hash>`）加载变更模块，天然绕开缓存冲突；已运行容器的旧模块实例随旧 fiber dispose。

**Bun 下不伪造 `loader.internal`（拆雷）**：

- 删除 `dsh-web.ts` 中 `loader.internal = { import }` 的注入；裸包名解析改为 Bridge 侧显式 resolver：`mountProfile` 在组合补丁栈前把所有行 `name` 中的裸包名解析为闭包/安装区的绝对 `file://` URL，再交给 Loader。
- 官方代码路径兼容性依据：`PresetTree.import`、`HostResolvedRootInclude.import` 在 `internal === undefined` 时回落 `super.import`（原生 `import()`），`file://` URL 直接命中。桥接行为与官方 embedder 语义一致。
- 该变更使官方 `cordis-plugin-hmr` 在 Bun 下的构造器守卫**确定抛错**（而非侥幸通过后误用私有 API）——这是期望行为，Bun 路径挂载的是 bun-hmr。

**热换安全边界**：

- 影响会话核心的变更（agent-loop/session/compaction 类行）推迟到当前请求结束的空闲窗口；等待有上限（超时记 `pending` 状态并在 UI 提示，不强杀会话）。
- bun-hmr 自身失败（watcher 建立、候选校验）只降级为「变更待重启生效」，绝不影响容器现有服务；所有失败经 log-bridge 结构化上报。

**与现有插件轮询重放机制的关系（bun-hmr 是升级而非替换）**：

- 现状：`startDshPluginService`（`packages/ellamaka-cordis/src/plugins/runtime.ts`）每 2 秒轮询插件真相源（生态对齐迁移后为 profile 组合文件：`package.json`/`cordis.patch.yml`）的 hash，变化即对 web/tools 两容器 `includeEntry.update()` 重放完整补丁栈（P6 插件供应链的热挂载底座）。它是官方 HMR 在 Bun 下不可用时的替代品。
- bun-hmr 完成后：**轮询（每 2 秒 hash 对比）被 chokidar 事件驱动取代**；但组合逻辑与 `includeEntry.update()` 热挂载原语**保留**，bun-hmr 的 generation 候选替换正是复用 `startDshPluginService` 的组合逻辑（见上「模块热换的 Bun 替代路径」第 1 步）。删除该机制会让 bun-hmr 失去组合底座。

**现状缺陷：失败重试风暴（B2 必须修复）**：

- `runtime.ts` 的 `tick()` 在 replay 失败后执行 `lastHash = undefined`（"forget the hash so the NEXT tick retries"）。这使下一个 2 秒 tick 再次读取同一坏 store、再次失败、再次清零——**无退避、无停止条件地无限重试**。
- 每个失败 tick 都执行一次 `includeEntry.update()` → 组合重挂 → 重置依赖它的 SSE/WebSocket 连接 → 前端 `dsh-client-connection` 指数退避重连。**日志风暴与后端断线重连是同一循环的两个现象**（实测同现），直到引擎重启才停。
- 修复方向（归属 B2）：失败时应保留旧的 `lastHash`（失败不算数，等下一次真实 store 变更再试），而非清零重试同一坏状态。这是 bun-hmr 改造现有重放路径时一并修复的缺陷。

**Spike 实测结论（S-2，不可再走解析拦截）**：

- `.wopal-space/.tmp/spike/s2-plugin.mjs` 实测：`Bun.plugin({ setup(build) { build.onResolve(...) } })` 注册成功、暴露 `onResolve` API，但**不影响运行时的 `await import()`**——`@wopal-spike/missing` 依旧 `ERR_MODULE_NOT_FOUND`。Bun 的 `Bun.plugin` 拦截只作用于构建期（bundle），运行时模块解析不在其内。
- bun-hmr 不依赖此能力（走 include update + 内容寻址 URL），该结论仅作记录，防止将来再尝试用 `Bun.plugin` 做运行时解析拦截。

**B3 传递的适配教训（B2 实现前必读）**：

- **rc.1 破坏性变更的模式是「读面服务化」**：Session 事件日志从裸数组升级为 seq 编号读面（`snapshotEvents`/`eventAt`/`seq` 连续性契约，sandbox-policy 与 approval 的折叠都走它）；connection 服务化（browser-auth）；HMR 服务位收敛。凡 facade/适配层引用官方服务形状的，**以闭包内实际代码为对齐基准**，不参考历史设计稿——B3 的 tools 断链事故（dsh-adapter session facade 停在旧契约）即源于此。
- **测试与受测服务同副本**：bun 的多副本物化使 Symbol/WeakMap 跨副本失联（B3 scope-instances 4 测试重写的教训）；bun-hmr 测试中任何服务位断言必须与受测容器同副本解析 cordis。
- **lock/manifest 物料链已闭环**（B3 提交 `5e587e8b2c`）：lock 生成器自带新鲜度门禁与键规范化，optional 语义落地；B2 涉及闭包再生物料时直接复用，无需另建防护。

**打包 Desktop 的 HMR 路径（已验证）**：Electron utilityProcess 不暴露 Node internal 模块——`--expose-internals` 仅进入 execArgv，`internal/modules/*` 仍不可 require。因此官方 `cordis-plugin-hmr` 在打包 Desktop 同样不可用，bun-hmr 适配器即 Desktop 路径（统一回退适配器，Node 路径"官方插件可用"的假设不成立）。热禁用后服务端卸载，client 设置导航残留至页面刷新（已知限制）。

### tool-cordis 注册冲突的宿主侧缓解

上游未修（进程级 id 去重），宿主侧在本闭包版本内执行缓解：

- **wopal 配置单**：已移除 `tool-cordis` 行（2026-09-03 已实施），恢复条件 = 上游把注册表按 agent scope 化或幂等。
- **创造模式单会话约束**：官方 `cordis` preset 内置 `tool-cordis`，同一引擎最多一个该 preset 的活动会话；第二个会话挂载失败回落 default。此约束作为已知限制记录，不在宿主侧 hack（修改官方 preset 违反「已验证事实 · 官方配置单在闭包内不可变」）。
- **会话恢复顺序**：resume 大 preset 会话先于新会话创建发生时，同样受此约束；Bridge 不做挂载重试风暴抑制之外的额外干预（错误已被 loader 聚合，UI 侧由挂载失败回落语义兜底）。

### 闭包升级路径（0.1.1-rc.2 → 0.1.2-rc.1）——**已由 B3 执行完毕（2026-09-05）**

> 以下 1-5 条作为已执行的升级记录保留（验收清单供 Desktop sidecar 回归时复用）；第 6 条「升级收益」中 watch-only patch 热加载一项经实机证伪——见「官方 0.1.2-rc.1 机制事实」的 Node-only 修订，该收益改由 bun-hmr 兑现。实施偏差（loopback 别名、vite Origin 对齐）已并入「浏览器认证」相应条目。

1. **版本提升**：`packages/ellamaka-cordis/package.json` 六个 `@deepseek-ai/*` 直接依赖提升至 `0.1.2-rc.1`（`cordis`/`cordis-plugin-loader` 保持 4.0.2/1.0.3，官方未变更）——已随提交 `1bb2d2674f` 落地，且 manifest 携带全量 closure 依赖集。
2. **manifests 再生**：`dsh-runtime-manifest.json` 与 `dsh-runtime-lock.json` 已再生（582 包、66 optional 条目、指纹 892d5933），Runtime Manager 实机物化新闭包成功，旧闭包保留。
3. **stateHomePatches 复核**：`dshHomePath` override seam 未变（实机 state 目录行为正常）；`session-persistence-jsonl` 在 web 容器保持禁用（tools 容器语义不变）。
4. **agent-presets 行为回归**：双根发现与 standing mount 复检随 B3 实机验证通过。
5. **Bun 路径回归清单**：serve（Bun）下 web+tools 双容器挂载、wopal 配置单挂载、`/global/health`、`/dsh` iframe 全链路（token 交换 → cookie → 对话 E2E）已实机全绿；插件 add/enable/remove 热挂载与 Desktop sidecar（Node）同清单回归已随 B2 验证窗口执行完毕（2026-09-06，见「打包 Desktop 的 HMR 路径」）。
6. **升级收益（修订）**：base bundle 的 PTC tools mode env seam、http-proxy 版本对齐等 rc.1 修复已随升级获得；watch-only patch 热加载在 Bun 下不可用（官方回退被构造器守卫阻断），该项收益由 B2 的 bun-hmr 兑现。

### 非目标

- 不在宿主侧实现 Node `loadCache` 等价物或 `--expose-internals` 仿真；Bun 不提供这些私有结构，伪造已被证实是事故温床。
- 不修改官方闭包内任何包（含 `cordis` preset 与 `tool-cordis`）；上游缺陷以升级跟踪。
- 不在本设计内处理 FrameQueue 背压与 agent-loop delta 合并——两者属上游缺陷，宿主侧仅以「会话隔离 + 大会话不自动 resume」缓解，修复跟踪官方仓库。

---

## 多空间解耦与实验 profile（独立主线）

> **状态**：E 线立项（2026-09-06），设计方向已定，暂不排期。本节描述目标形态；实现细节留待 E 线 dev-flow Plan。
> **关联**：本节是「运行时机制 · 助理 tab 承载」的演进——遮蔽耦合是 P7 的设计债，本节将其拆除为空间化模型。

### 定位与目标

当前 dsh iframe 以遮蔽方式占用 workbench「助理」tab：`dshVisible = dshEnabled && 激活 tab 是 General`（见「运行时机制 · 助理 tab 承载」）。这是 P7 的设计债——同一个 tab 在不同开关下代表两个完全不同的产品系统（ellamaka 原生助理 vs dsh web UI），心智模型分裂，也无法承载第二个 dsh 环境。

E 线把 DSH 呈现从「遮蔽」升级为「独立空间」，并开辟实验性第三方 profile 的隔离运行轨道：

1. **语义各归其位**：「助理」（ellamaka 通用空间）与「DSH」（web profile 空间）是两个并列的独立空间，而非一个遮蔽另一个。
2. **开关配置化**：DSH 空间启停从环境变量 kill switch 演进为两层配置模型（`settings.jsonc` 默认值 + 设置面板运行时覆盖）；`ELLAMAKA_DSH` 保留为硬逃生舱。
3. **实验隔离**：实验性第三方插件（依赖历史闭包、安全边界存疑）经独立进程 + 独立 home 运行，不进入主 Web 容器，不污染日常环境。
4. **Profile 即空间**：dsh profile 概念映射为 workbench 空间——正式 web profile、实验 profile 在顶栏并排呈现。

### 空间模型

Workbench 顶栏的空间类型扩展为三类：

| 空间类型 | 标识 | 内容 | 进程归属 |
|----------|------|------|----------|
| **助理** | `assistant`（原 General，path `""`） | ellamaka 原生通用会话空间 | ellamaka serve 进程 |
| **DSH** | `dsh` | dsh web profile（完整 dsh UI） | ellamaka serve 进程（同进程，Web 容器） |
| **实验 profile** | `dsh-profile:<id>` | 指定闭包 + 指定 profile 的隔离 dsh 实例 | 独立进程 |

- 助理与 DSH 各自独立开关、独立持久化 activeTabPath；互不遮蔽。
- 实验 profile 是注册式实体：一个实验 profile = 一个独立进程 + 一个空间 tab，携带独立 URL 入口与健康状态。
- ellamaka 工具容器（`ellamaka-tools` profile）保持同进程，不作为独立空间呈现——它服务于工具投影，不是用户可见空间。

### 配置模型

DSH 相关配置采用两层模型（与「配置与隔离 · 进程级共享、空间级隔离」的 settings.jsonc 机制一致）：

| 层 | 位置 | 作用 | 修改方式 |
|----|------|------|----------|
| 默认值 | `settings.jsonc`（`ellamaka.dsh.*` 域） | 定义 DSH 空间、助理空间的启停默认值与实验 profile 注册清单 | 编辑配置文件，重启/重载生效 |
| 运行时覆盖 | 设置面板 + 持久化 store | 用户在界面内修改，立即生效并持久化（本机覆盖） | 设置面板 UI |

合并逻辑：面板有值用面板值，未设置回落 `settings.jsonc` 默认值。与现有服务器列表持久化机制（`Persist.global`）同一套技术路线。

具体键位（draft，待 E1 Plan 定型）：

```jsonc
{
  "ellamaka": {
    "dsh": {
      "enabled": true,           // 引擎挂载门控（对应 ELLAMAKA_DSH 的配置化形态）
      "spaceVisible": true,      // DSH 空间 tab 显隐默认值
      "profiles": [              // 实验 profile 注册清单（默认值层）
        {
          "id": "oil-lab",
          "title": "Oil Creator",
          "closure": "971a81a03700",
          "profile": "oil-lab",
          "home": "$WOPAL_HOME/dsh/experimental/oil-lab/home"
        }
      ]
    },
    "assistant": {
      "enabled": true            // 助理空间启停默认值
    }
  }
}
```

**`ELLAMAKA_DSH` 逃生舱保留**：配置化开关服务于日常使用；`ELLAMAKA_DSH=0` 仍是硬禁用路径（跳过物化、加载与挂载，见「统一启动语义」）。env 显式设置时优先于配置——与 opencode 惯例一致，且保证配置损坏时仍有自愈手段。

### 进程拓扑

**核心容器保持同进程**：web profile + ellamaka-tools profile 继续与 ellamaka serve 同进程（单端口、单进程、零延迟工具调用，见「架构总览 · 单进程、单端口、双容器」）。这是核心基建，没有拆分理由。

**实验 profile 独立进程**：每个启用的实验 profile 由独立进程承载。隔离收益：

1. **闭包版本隔离**：实验进程可绑定任意历史闭包（如 dsh-oil-creator 要求的 `0.1.0-rc.7` 窗口），主进程继续跑 `892d593303e0`，避免单进程内双版本 `@deepseek-ai/*` 冲突。
2. **故障防扩散**：实验插件崩溃、死锁、爆内存不影响主进程与正式 DSH 空间。
3. **home 隔离**：实验进程使用独立 DSH_HOME（`$WOPAL_HOME/dsh/experimental/<id>/home`），**不与主引擎共享 home/profiles**——运行中引擎 `profiles/` 是引擎领地（2026-09-04 事故教训），两进程共享 profile 目录必然冲突。

**启动范式（当前方向）**：独立 CLI 启动 + workbench 注册（用户自起、自己连）。`ellamaka dsh up --profile <name> --closure <fp> [--port 0]` 独立跑出 authenticated entry；workbench 通过服务器管理式界面注册（复用 `context/server.tsx` 的 add/健康探针/持久化范式），注册后成为空间 tab。主进程对实验进程零感知、零生命周期看管职责——隔离最干净，崩溃与主程序零关联。

### 闭包版本物化扩展

当前 Runtime Manager 只物化 host 锁定的版本集（见「运行时机制 · 物化状态机」）。实验 profile 需要物化**指定历史版本**的闭包（dsh-oil-creator 的 peer 窗口是 `0.1.0-rc.6 || 0.1.0-rc.7`，现有闭包 `892d593303e0`=0.1.2-rc.1、`971a81a03700`=0.1.1-rc.2 均不满足）。E 线新增能力：

- 物化指定版本 → seal 进 `closures/<fingerprint>`（复用「统一自物化」的 lock/stage/verify/activate 管线，版本来源从内嵌清单改为显式参数）。
- 物化结果遵循「不可变闭包」约束：只增不减，成功后永久保留，同指纹无限复用。

### 前端机制

- **tab 模型**：助理、DSH、实验 profile 在顶栏并排；`dshVisible` 从布尔派生改为按空间 id 派生；激活空间决定 Surface 呈现。
- **keep-alive iframe 池**：每个 dsh 类空间持有一个 keep-alive iframe（沿用「助理 tab 承载 · keep-alive」的 display 切换不变量）；切 tab 不重载 iframe，会话状态保留。
- **健康圆点**：复用现有 per-server 健康探针范式（`useCheckServerHealth`），实验进程状态映射到空间 tab 指示。
- **`WorkbenchDshFlagBinding` 职责扩展**：从单一 `health.dsh` bool 扩展为「引擎挂载态 + 实验空间清单」两类信号。

### 与既有设计的衔接

- **替代**：本节演进「运行时机制 · 助理 tab 承载」的遮蔽语义；E1 落地后遮蔽模型退役。
- **设计约束**：新增约束「多空间解耦与实验 profile 隔离」（见「设计约束 · 多空间解耦与实验 profile 隔离」）；其余约束（单进程核心容器、统一自物化、不可变闭包、DSH home 唯一）保持不变。
- **与 A 线**：E1 不依赖 A 线施工内容；E2 依赖 A2 的官方声明供应链（实验 profile 内装插件长期形态走 Bun 安装器终态）。
- **与 W 线**：W4 是 E2 的首个实证消费者——通过实验空间评估外部插件（如 dsh-oil-creator）并产出评估报告。
- **与 G 线**：正交。G 线解决「把有真实价值的 dsh 前端插件 UI 搬进 workbench」；E 线解决「怎么安全地运行与评估第三方插件」。G 线启动前提（W4 出价值插件 + workbench slot 化）不受 E 线影响。

---

## 壳单端口化与 workbench 精简（独立主线，S 线）

> **状态**：S 线立项（2026-09-06），设计方向已定，暂不排期。本节描述目标形态与阶段边界；实现细节留待 S 线 dev-flow Plan。
> **关联**：本节是「运行时机制 · 单端口分发」「iframe 地址派生」的壳侧演进；与 E 线（空间模型）正交，与 B5（认证联盟）互不冲突。

### 定位与动机

ellamaka 的终局形态是「**一个 runtime，N 个壳**」：server 是唯一完整的运行时产物（引擎 + SPA + dsh 表面），壳（desktop / 浏览器 / mobile WebView）只是找到 server 端口并加载其 UI 的容器。当前 desktop 违背这一形态——packaged renderer 住在特权 `oc://renderer` origin，导致三个结构性 workaround：

1. **硬编码 4123 代理端口**：Chromium 拒绝在 `oc://` origin 发起 WebSocket（scheme 白名单硬编码），DSH realtime 通道（remote.mux）必须 WS，因此主进程额外起一个 node:http server 作为 iframe 的 http 宿主 + cookie jar + WS 转发层。
2. **进程内 cookie jar**：`oc://` 父页面与 `http://127.0.0.1:4123` iframe 跨站，SameSite=Strict cookie 浏览器拒发，代理只能截获 set-cookie 自行管理。
3. **双代理实现**：`createDshProxy`（fetch 版）与 `createDshHttpProxy`（node:http 版）两套镜像代码，外加 `platform.dshProxyOrigin` 全链路（main → getWindowConfig → platform → dsh-surface 的 `oc:` 特判）。

硬编码端口使多个 desktop 实例或测试进程无法共存。S 线消除这一整层。

### 终局路由表

官方 opencode app（HomeRoute / DirectoryLayout / session 页面）从 SPA 移除，desktop 从不加载官方路由（DesktopRouter 用 memory history 强制从 `/workbench` 启动），官方 UI 只是历史包袱。移除后路由终局：

| 路径 | 移除后 | 机制归属 |
|------|--------|---------|
| `/` | **设备协商前门**：302 移动 UA → `/dsh/`，桌面 UA → `/workbench` | Effect 栈显式路由（`GET /` 一条，静态 UA 判断，无配置项） |
| `/workbench` | 桌面工作台，canonical 深链 | SPA 客户端路由（保留） |
| `/workbench/*` | workbench API | Effect 显式路由（不变） |
| `/dsh/*` | 助手表面，canonical | VirtualWebServer 挂载（不变，B5 领地） |
| `/doc`、`/event` 等 | 引擎 API | Effect 栈（不变） |
| `/:dir`、`/:dir/session/:id` | 删除（官方会话页随官方 app 移除） | — |
| 其余路径 | SPA fallback → workbench | uiRoute catch-all（不变） |

**`/` 选择重定向而非直挂 workbench**：保留唯一 canonical URL，避免 `/` 与 `/workbench` 双地址分裂 deep link、存储键与 e2e fixture。**`/dsh` 不升根**：适配层三块改写逻辑（index 资源绝对化、303 Location 前缀改写、base 锚定）已完成且有测试，维护成本趋零；升根则破坏「一个前缀一个自治表面」的挂载不变量（dsh 内部硬编码 `/api` 将与引擎 API 共享根命名空间）、desktop `isDshPath` 代理判据与 B5 认证联盟的信任域边界（Basic 守外层、cookie 守内层，边界就是前缀）。设备协商前门让 mobile 设计（`DESIGN-mobile.md`）的「手机浏览器直连即全屏助手」在人肉入口层面成立，移动 App 仍硬编码 `/dsh/` 直连（零跳转）。

**DESIGN-mobile 的启示**：DSH 不是 workbench 的一个功能，而是横跨双端的独立产品表面（桌面内嵌 tab + 移动端全屏）。desktop 单端口化正是把 desktop 拉回「一个 listener 服务所有表面」的三端统一原则——web serve、desktop、mobile 各自只有一个端口。

### 壳契约（跨阶段不变量）

**壳只做一件事：找到 server 端口，loadURL 它的 `/workbench`。**

- renderer 永远活在唯一一个 http origin 上（server 端口）；cookie、WS、iframe 同源、多实例隔离全部挂在这条不变量上。
- server 端口启动时分配随机空闲端口（sidecar 已如此），多实例/测试进程天然隔离。
- onboarding 仍住 `oc://`（sidecar 未起时没有可加载的 http origin），onboarding→workbench 转场为顺序导航到 http origin。
- sidecar 重启保持同端口：重启是页内 reconnect UI，renderer 不随端口变化重载。

### 引擎产物纪律

- 引擎只有一个产物形态：**完整 CLI 二进制**（引擎 + SPA + dsh-mount，`ellamaka-release` 的 `--web-ui ellamaka-app` 默认产物）。
- server 来源三种形态自由组合，壳代码不感知差异：外部已装 CLI（优先，版本握手，`MIN_WOPAL_CLI_VERSION` 协议地板）；随 app 捆绑的同一 CLI 二进制（兜底）；远程 ellamaka serve（多服务器场景——壳直接 loadURL 远端 `/workbench`，UI 与 API 永远同版本）。
- 禁止维护第二套分叉的引擎构建产物（现有 sidecar.js 独立构建链在 Phase 2 退役，见下）。

### 阶段边界

**Phase 1（POC 内，本线执行）**：单端口壳化，sidecar 保留。dsh 生态尚未完全 Bun 兼容，desktop 引擎需要 electron node 环境（utilityProcess）承载 serve 服务——sidecar 构建链是 POC 的现实，不是设计错误。改造内容：

- renderer 从 `oc://` 迁到 `http://127.0.0.1:<sidecarPort>/workbench`；sidecar 开始 serve SPA（从 resources 目录 serve electron-vite 已产出的 `out/renderer`，引擎侧 serveUI 加目录 fallback，UI 与引擎构建解耦）。
- **删除 4123 整层**：`dshHttpProxy`、`createDshProxy`、进程内 cookie jar、`platform.dshProxyOrigin` 链路、`dsh-surface.tsx` 的 `oc:` 分支——同源后 cookie 与 WS 浏览器原生处理，desktop 走 web 模式代码路径（`pageOrigin = location.origin`，`dshIframeSrc` 回落 `<origin>/dsh/`）。
- utilityProcess 结构化 IPC（sqlite 迁移进度、日志级别）替换为 HTTP 健康检查 + 日志流，supervisor 保持 spawn factory 接口复用。

**Phase 2（dsh Bun 兼容收敛后）**：引擎产物唯一化。desktop spawn 捆绑的 CLI 二进制 serve（Bun）；sidecar 构建链（`virtual:opencode-server` 插件、`build-node.ts` 置空 gen、`source-ts-loader`、`--experimental-strip-types`）整体退役；server 来源优先级生效，壳代码零改动。Phase 1 删除 4123 的全部投资直接带入 Phase 2——sidecar 只是 Phase 2 到来前临时占据「server 来源」插槽的占位实现。

### workbench 精简（同线顺带）

- **i18n 收敛**：两包（ellamaka-app、@wopal/ui）各 18 语言文件收敛为 en/zh；同步收缩 `Locale` 类型、LOCALES/INTL/LABEL_KEY/loaders、设置页语言选择器、parity test。纯数据删除。
- **theme 收敛**：37 个主题 json 收敛为 ellamaka（默认）+ 最多 1–2 个备选；保留 loader/schema/注册机制，删数据不删机制，未来加主题零成本。
- **官方 app 移除**：删 HomeRoute / DirectoryLayout / session 三条客户端路由与官方壳（`pages/home.tsx`、`pages/directory-layout.tsx`、`pages/session.tsx`、`pages/layout.tsx` + `pages/layout/`、`components/titlebar.tsx`）；随后死代码清扫（workbench chat 依赖 `pages/session/` 下 7 个模块——composer、chat-transcript、workbench-chat-timeline、session-surface-context 等，该树不能整删，清扫以工具裁决引用）；同步清理 i18n 键与 e2e session-timeline 用例。

### 与既有设计的衔接

- **与 B5**：正交且互护。B5 的信任域边界（Basic 外层 / cookie 内层）在单端口后依然成立——同源只是让 cookie 回到浏览器原生管理，fence、WS 探针、`/workbench/dsh-url` 分发面全部不动。B5c 的 mount 认证声明契约是 E 线前置，与 S 线共享「前缀自治」不变量。
- **与 E 线**：正交。E 线解决空间模型（tab 语义），S 线解决壳与端口（加载方式）；E 线的独立 profile 进程挂载继续走 `Listener.mountNodeRoute` 前缀挂载，不受影响。
- **与移动端（DESIGN-mobile）**：S 线落地后三端统一「一个 listener，所有表面」；`/` 设备路由是 Tailcat 二维码只编码根 URL 的前提——设备自选表面，未来移动表面演进二维码不变。
- **设计约束**：新增约束「壳单端口不变量」（见「设计约束 · 壳单端口不变量」）；其余约束（单进程、单端口分发、DSH home 唯一、Bun 宿主兼容性门禁）保持不变。

---



> 前身为主线方向（2026-09-02 定稿方向二）。2026-09-03 重排优先级：**wopal 插件包先行**——先把 dsh 插件用起来（自建 + 外部发现），用出真实价值后再评估 WC 化吸收。

### 定位与启动前提

dsh 前端插件体系（React + 声明制 slots）与 ellamaka workbench（SolidJS）是两套框架，组件经 **Web Component（WC）** 跨框架插座互通。方向二：dsh 前端插件补 `ellamaka.ui` 面（WC 壳），由 workbench 定义 slot 面加载——主导权在 ellamaka，与「ellamaka 吸收 dsh 能力」主线一致。

**启动前提**（两条同时满足才排期，否则不启动）：

1. **插件生态在真实使用中**：自建插件（武器架、空间皮肤等）已日常在用，且外部发现的 dsh 插件中有被实际留存使用的案例——有真实插件才有值得 WC 化的对象。
2. **workbench slot 化完成**：workbench 侧已建立 3–5 个挂载点与 props 契约。

### 一包多面

一个插件包三个激活面，profile `package.json` 是唯一真相源，`enable/disable` 一个动作管三处：

| 面 | 目标 | 机制 | 状态 |
|----|------|------|------|
| `dsh.bundle.patch` | dsh 服务端容器（工具/服务） | 供应链 | 已达成 |
| `dsh.client` | dsh GUI（React + slots） | 组合图动态派生 | 已达成（hello 前置实证） |
| `ellamaka.ui` | workbench（WC + slot 声明） | 本节新增 | 门槛轨道，未启动 |

新增 manifest 面：`package.json → ellamaka.ui: { entry: "./lib/ellamaka.js", slots: [...] }`。插件作者用 React 写组件包 WC 壳，或纯 TS 写轻组件；WC 自包含运行时，Shadow DOM 提供样式隔离。

### 数据通道

dsh 容器 HTTP 面挂在主 server `/dsh/*`（VirtualWebServer），workbench 页面与之**同源**（prod 同一 server；dev 由 Vite `/dsh` proxy 转发）。dsh 第三方插件「服务端 `ctx.webServer.register` 路由 + 客户端 fetch `/dsh/...`」的标准数据模式在 workbench 中原样成立——写得规范的 dsh 前端插件，数据面在 workbench 天然可用，改造量集中在 UI 壳。

容器未运行时，数据请求失败的降级语义由 workbench 加载器承担：WC 显示不可用态，不污染宿主。

### 执行清单（启动后按序执行，每步独立可逆）

| V# | 验证 | 内容 | 通过判据 |
|----|------|------|---------|
| V1 | 同源连通 | Bridge 静态路由 `/dsh/ellamaka-ui/<pkg>/<ver>/*` + Vite `/dsh` proxy | workbench fetch 插件 WC 文件返回 200 |
| V2 | 加载器最小链路 | profile package.json 含 fixture（`ellamaka.ui` 声明）→ 加载 → 挂载 → 卸载 | fixture WC 在声明 slot 挂载并正确卸载；remove 后不再挂载 |
| V3 | 数据面实证 | fixture 插件服务端 register `/dsh/fixture/status` | WC 同源 fetch 渲染真实数据 |
| V4 | 真实插件实证 | fork 一个在用 dsh client 插件补 `ellamaka.ui` 面 | `add` → watcher 热挂载 → workbench 显示实际功能 |
| V5 | 失败语义 | 容器未起 / 插件加载异常 | 不可用态降级；插件崩溃被错误隔离，宿主其余槽位不受影响 |

### 平台侧改造清单（启动后实施）

| 件 | 归属 | 内容 |
|----|------|------|
| 静态路由 | Bridge | `/dsh/ellamaka-ui/<pkg>/<version>/*` 服务 plugins 目录 WC 文件（`/dsh/plugins/*` 是 dsh registry 专用，不复用） |
| dev proxy | ellamaka-app | Vite `/dsh` 转发到 serve |
| workbench slot 面 | ellamaka-app | 初始 3-5 个挂载点（会话侧栏、会话头部、设置页项等）+ 每个 slot 的 props 契约 |
| WC 加载器 | ellamaka-app | 读 profile package.json → 过滤 `ellamaka.ui` + enabled 含 "workbench" → 动态 import → Shadow DOM 挂载 → 错误隔离 → 卸载 |
| enabledIn 语义扩展 | 供应链 | "workbench" 加入启用面取值（「设计约束 · 插件安装共享、启用按 profile」的延伸） |

### 与既有约束的衔接

- **信任面**：WC 与 workbench 同页面上下文，可信度等同 dsh 插件同进程执行（用户显式安装 + `add` 风险提示，见「插件供应链 · 配置与信任」），不新增权限体系。
- **单真相源**：profile `package.json` 不新增第二清单；实现决策 D-04 保持。
- **官方闭包不变**：`ellamaka.ui` 面仅消费方为 ellamaka，不触碰官方闭包、不进入 dsh GUI 运行时。

---

## dshmarket 插件市场接入

**定位**：dshmarket 是官方 dsh 生态的可视化插件市场（Settings → Plugin Market），浏览/安装/更新/卸载社区插件（2300+ 条目目录）。官方安装与机制在 `docs/products/wopal-space/research/dsh/dsh-market-installation-analysis.md` 记录（2026-09-05 实测）。接入 Ellamaka 遵循「插件供应链」的生态对齐设计：**市场代码零修改，宿主提供安装工契约**。

### 接入机制

市场 `apply(ctx, config)` 需要 `webServer` 与 `loader` 两个服务——Ellamaka web 容器原生提供（VirtualWebServer + Loader）。安装执行走市场的**宿主安装工契约**：宿主注入 `desktopProfiles`（profile 名与目录）与 `desktopPnpm`（安装执行接口）后，市场完全经注入接口执行安装/卸载/恢复，不 spawn CLI、不依赖 pnpm。安装接口实现 = Bun 安装器（见「插件供应链 · Bun 安装器流水线」）。

市场路由挂 `webServer`，按 `/dsh` mount 前缀重写（与官方 web 资产重写同理）。市场自身状态目录 `.dsh-market/` 按 DSH_HOME 语义落在 profile 目录内。

### 生态兼容边界（源码实证）

| 市场能力 | 机制 | Ellamaka 兼容性 |
|----------|------|----------------|
| 安装/卸载 | 宿主安装工接口，exitCode 0 判成功 | 原生工作；接口由 Bun 安装器实现 |
| 安装后校验 | 读 profile package.json `dsh` 字段 + entry 在 node_modules 可解析 | 终态文件由 Bun 安装器按官方语义摆放，校验通过 |
| 已装列表 | 读 profile `package.json` dependencies | 与真相源一致 |
| 热禁用/启用 | 追加 profile `cordis.patch.yml` 行 | 组合文件监听触发热重放（D-02） |
| 快照/恢复 | 存 package.json + cordis.patch.yml + .dsh-market/state.json | 原生工作；恢复的裸 install 走安装工 `install` 动词（D-07） |
| 更新自动回滚 | 按 pnpm-lock.yaml 字节恢复 | **已知偏差**：Bun 安装器不产 pnpm-lock，回滚退化为按快照声明重装（语义等价） |
| 进度显示 | pnpm ndjson 阶段事件 | 可选增强；缺省退化为普通进度 |
| GitHub 源安装 | git clone + build | 第二期实现；第一期明确报错 |
| 自重启 | SIGTERM 宿主进程 | `allowRestart: false` 注入关闭 |
| client.inject | 前端模块注入 Settings | 走官方 web-app 的 client 机制；接入探针实测确认 |

### 实施步骤

1. **宿主安装工**：实现 `desktopProfiles` + `desktopPnpm` 注入（service 定义 + Bun 安装器三动词桥接）。
2. **dshmarket 安装探针**：用 Bun 安装器以官方声明形态安装 dshmarket 进 profile，验证 `apply()`、路由挂载、Settings → Plugin Market 入口可见（client.inject 链路实测确认）。
3. **端到端验收——通过市场安装真实插件**：在 dshmarket UI 中一键安装 `dsh-better-sidebar`，确认引擎加载成功、右侧 sidebar UI 可见可用（含 explorer/git/terminal tab）。这是 A 系列生态对齐的端到端证明——市场代码零修改、安装工链路打通、引擎正确加载第三方插件、client 注入链路生效。
4. **市场后续操作验收**：禁用/启用 better-sidebar 后引擎热应用生效；快照/恢复验证；已装列表与 profile package.json 声明一致。
5. **收尾**：按「插件供应链 · 验收基线」#2 完成市场全流程验收。
