# WorkBuddy 内置浏览器机制逆向研究与路径 A/B 可实施性分析

> **文档定位**：记录 WorkBuddy 5.11.3 内置浏览器（IAB）与 Browser Use 插件 1.2.2 的现有实现证据、逆向结果及候选复现路径。本文是技术研究报告，不构成 Ellamaka 的架构选型、DESIGN 修订或实施授权。
> **研究日期**：2026-11-14
> **设计真相源**：Ellamaka 的正式设计以 [DESIGN.md](../../DESIGN.md)、[DESIGN-desktop.md](../../DESIGN-desktop.md)、[DESIGN-dsh-web.md](../../DESIGN-dsh-web.md) 为准。
> **结构化证据**：[`./workbuddy-browser-mcp-provider-evidence.json`](./workbuddy-browser-mcp-provider-evidence.json)（保留 MCP 实际工具 Schema、Ghidra 字符串引用和函数反编译状态；不包含第三方二进制或完整反编译代码）。
> **状态**：研究中；路径 A/B 均保留，尚未作产品决策。

---

## 研究目的与结论

本次研究关注的是 **WorkBuddy Desktop 内置浏览器为什么能被 Browser MCP 操控**，特别是 Desktop 侧的 Browser Provider、浏览器宿主和 Controller。浏览器插件的启停机制、Agent 工具的动态装载、浏览器扩展安装流程均不是本轮研究重点。

初步结论：

- **Desktop 侧核心实现可直接阅读**：Browser Provider、Browser Controller、Browser Manager、页面宿主和 DOM/CDP 控制均存在于发布版 Electron ASAR 的 JavaScript 中。它是打包/压缩代码，并非原始 TypeScript 工程；研究这部分不需要 Ghidra 原生反编译。
- **原版 Browser MCP 可以独立启动**：可在隔离环境通过标准 MCP `initialize` / `tools/list` 获取其服务信息、32 个工具及对应输入 Schema。其接口不必靠反编译猜测。
- **原生二进制可以进行业务函数级反编译**：Ghidra 成功识别 1,780 个函数，针对协议/工具相关引用尝试反编译 13 个候选函数，其中 12 个成功生成 C 风格伪代码，1 个较大分派函数超时。
- **路径 A（保留原版 MCP、自建 Desktop Browser Provider）技术可行性高**：此前模拟 Provider 实验已证明一部分通信链路能够工作，仍缺完整真实浏览器集成与全工具行为验证。
- **路径 B（自建 MCP、自建 Desktop Browser Provider）技术可行性也高**：接口合同可直接取得，协议与工具分派关键函数可定位；但输出合同、异常语义和完整行为等价性还没有得到系统验证。

这里的“可行性高”是**研究阶段的技术判断**，不是“已实现稳定复刻”或“可以直接分发商业产品”的结论。

## 研究对象与证据分级

### 发布产物身份

| 对象                                 | 实测身份或位置                                                                                                                       | 证据用途                                  |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| WorkBuddy Desktop                    | macOS 5.11.3，`/Applications/WorkBuddy.app`                                                                                          | 内置 IAB 的 Electron 主进程实现           |
| Electron ASAR                        | `Contents/Resources/app.asar`，SHA-256 `45965c389b9674ef359fb5fc331a40ca0c0777c8380104f2e9ea8950bced614f`                            | 锁定所研究的 Desktop 版本                 |
| Desktop JavaScript                   | ASAR 内 `main/main-bootstrap.js`，1,004,814 字节、595 行，SHA-256 `598ef38edaf23c655dfb3e0dfd119c129de3364d304ebec02cda0c87c350c1cc` | 主要 Desktop 代码分析对象                 |
| Browser Use 插件                     | 用户安装缓存 `.workbuddy/plugins/cache/workbuddy-browser-use/browser-use/1.2.2/`                                                     | MCP 可执行文件、插件配置和 Skill          |
| 原版 `browser-mcp`                   | Mach-O ARM64，1,235,712 字节，SHA-256 `4979d59bae493dc1c95d50c800d34c5bfdb6b25426d444600f9eb9646531e022`                             | MCP 实际行为和原生反编译对象              |
| 原版 `browser-extension-native-host` | Mach-O ARM64，595,744 字节，SHA-256 `2c72cd983dcd85e69f0a75500cabfd79eea5897fee1da4f44ac3f638368c0c00`                               | 外部浏览器扩展路径的旁证，非 IAB 必要组件 |
| 原版 Browser Use Skill               | 插件内 `skills/workbuddy-browser-use/SKILL.md`                                                                                       | Agent 使用浏览器的操作约定                |

路径均用于**在已安装的本机上定位原始产物**，不表示这些第三方文件属于 Ellamaka 仓库。插件 `.mcp.json` 指向 `${CODEBUDDY_PLUGIN_ROOT}/bin/browser-mcp`，其插件版本为 `1.2.2`；原生 MCP `initialize` 返回的内部服务版本则是 `0.2.1`，两者不是同一个版本号。

### 本文对证据的用词

| 标记              | 含义                                                                |
| ----------------- | ------------------------------------------------------------------- |
| **实测**          | 实际运行二进制或分析工具，获得可观察响应/分析结果                   |
| **静态代码证据**  | 在发布产物的 JavaScript、原生字节、函数引用或伪代码中确认存在的实现 |
| **历史实验**      | 前序会话曾测试成功，但未将原始请求/响应记录纳入本次持久化证据       |
| **推断 / 待验证** | 根据实现结构作出的工程判断，尚不能代表真实端到端行为                |

Ghidra 识别出的函数边界、调用约定和伪代码均可能受 Rust 优化、内联和符号缺失影响；**反编译伪代码不等于原始 Rust 源代码**。

## 已发现的整体调用结构

```text
Agent
  │  MCP tools/call
  ▼
browser-mcp（原生进程，stdio MCP Server）
  │  自定义帧格式 / JSON 消息；Unix Socket（macOS）
  ▼
BrowserProviderRouter（Desktop 主进程）
  │  Browser Session / Provider / 请求和取消路由
  ▼
ElectronBrowserRuntime
  │  每个 Agent Session 对应的 BrowserController
  ▼
BrowserController
  │  标签所有权、操作授权、方法分派、结束清理
  ▼
BrowserManager ── BrowserPageHost
  │                  │
  │                  ▼
  │             Electron WebContentsView
  │                  │
  └── DomCua / DomCuaCdp / 坐标 CUA
                     │ CDP / webContents.sendInputEvent / capturePage
                     ▼
                   真实网页

Desktop UI：与浏览器宿主同步标签、可视区域及原生页面视图
```

这张图依据发布版 JavaScript 的对象创建关系和操作分派构成，**不是对所有运行场景完成动态跟踪后的证明**。内置浏览器由 Electron `WebContentsView` 承载真实 Chromium 页面；预览 JPEG 是独立辅助路径，不应把 IAB 理解为“只显示远程截图”。

### Desktop 端可读实现

以下偏移是 `main/main-bootstrap.js` **解压后 UTF-8 文本中的字符位置**，不是 Mach-O 地址，也不是原始工程源码行号。它们便于在相同 SHA-256 的发布产物中重新定位类定义。

| 类                       | 文本偏移 | 静态可见职责                                           |
| ------------------------ | -------: | ------------------------------------------------------ |
| `BrowserPageHost`        | `441952` | 页面创建、原生视图挂载、尺寸与可见性                   |
| `BrowserManager`         | `452317` | 窗口/分组/标签与 Session 管理                          |
| `DomCuaCdp`              | `487900` | CDP 附着、目标与 frame 操作                            |
| `DomCua`                 | `508560` | DOM 可见快照及基于 CDP 的交互                          |
| `BrowserController`      | `535506` | 标签认领、授权、操作分派、清理                         |
| `ElectronBrowserRuntime` | `553686` | 创建并保存每个 Session 的 Controller                   |
| `BrowserProviderRouter`  | `555998` | Socket、握手、Provider 列表、请求/取消                 |
| `BrowserRuntimeHost`     | `568698` | 浏览器共享运行时、Session 准备、MCP 启动环境与生命周期 |

能够直接观察到的关键实现包括：

- `BrowserRuntimeHost.prepareSession()` 建立 Session 关联、注册并激活 Desktop Provider bucket，再为 MCP 进程注入 `BROWSER_MCP_SESSION_ID`、`BROWSER_MCP_PROVIDER_ENDPOINT` 等运行信息。
- `BrowserProviderRouter.bind()` 处理 `session_hello` 的协议范围与 Session 归属检查；路由器还处理 `providers_list`、`provider_invoke`、`provider_cancel`、`provider_result` 等消息。
- `ElectronBrowserRuntime.createSessionBrowser()` 将 `BrowserManager` 的标签查询、选中、打开和关闭能力注入 `BrowserController`。
- `BrowserController` 持有 `authorizations`、`tabOwners`、`tabReservations`、`tabGenerations` 等状态，说明它不仅是简单 RPC 转发层。
- `DomCuaCdp` 使用 `webContents.debugger.attach('1.3')`；`DomCua` 路径出现 CDP `Input.dispatchMouseEvent`；坐标操作另有 `webContents.sendInputEvent`，页面截图依赖 Electron 原生能力。

这些模块是**可以读的 JavaScript 发布代码**，不是可以不加修改直接独立启动的原始源码工程。ASAR 中未发现 `.map` Source Map；外部依赖、Electron 宿主初始化和 WorkBuddy 专有服务引用需要逐一厘清。

### Provider 侧已有合同线索

同一发布版代码中的 `BrowserProviderRouter` 包含下列值，均属于**原版 Desktop 的静态合同观察**，不自动成为 Ellamaka 的设计约束：

| 合同项                   | 原版代码观察                             |
| ------------------------ | ---------------------------------------- |
| `PROTOCOL_VERSION`       | `1`                                      |
| `MAX_FRAME_BYTES`        | `16,777,216`（16 MiB）                   |
| `MAX_IN_FLIGHT`          | `64`                                     |
| 默认 heartbeat 超时      | `15,000 ms`                              |
| 默认握手超时             | `5,000 ms`                               |
| 默认 Provider 类型、名称 | `desktop` / `WorkBuddy Browser`          |
| `tab_model`              | `multi_tab`                              |
| 握手声明上限             | `max_browsers: 1`、`max_tabs: 256`       |
| 本地连接校验             | 存在按宿主系统选择的同用户 peer 检查逻辑 |

这些上限说明原版协议的设计边界，不说明所有边界都经过动态压力测试。安全性也不能只从某一段自动批准逻辑推断：标签权限、Session 认领、peer 校验、运行时归属及用户确认边界均需要分别复验。

## 原版 Browser MCP 的接口与逆向结果

### 不依赖反编译就能获取的接口

在与用户配置隔离的运行环境里直接启动原版 `browser-mcp`，发送 MCP JSON-RPC `initialize`、`notifications/initialized` 和 `tools/list`，得到：

- `serverInfo.name = browser-mcp`，`serverInfo.version = 0.2.1`。
- **32 个工具**及实际 `inputSchema`。精确的参数、类型、必填字段和嵌套结构保存在相邻 JSON 附件中；下表只做分组索引。

| 分组           | 工具数 | MCP 工具                                                                                                                 |
| -------------- | -----: | ------------------------------------------------------------------------------------------------------------------------ |
| 浏览器发现     |      2 | `browsers_list`、`browser_info`                                                                                          |
| 标签与用户页面 |      8 | `tabs_list`、`tabs_selected`、`tabs_get`、`tabs_new`、`tabs_claim`、`tabs_close`、`tabs_finalize`、`user_open_tabs`      |
| 页面级操作     |      8 | `tab_url`、`tab_title`、`tab_goto`、`tab_back`、`tab_forward`、`tab_reload`、`tab_focus`、`tab_screenshot`               |
| 坐标 CUA       |      8 | `cua_click`、`cua_double_click`、`cua_move`、`cua_drag`、`cua_scroll`、`cua_keypress`、`cua_type`、`cua_execute`         |
| DOM CUA        |      6 | `dom_cua_get_visible_dom`、`dom_cua_click`、`dom_cua_double_click`、`dom_cua_scroll`、`dom_cua_keypress`、`dom_cua_type` |

**区分两层命名**：`tabs_new` 是 Agent 可见的 MCP Tool；`tabs.new` 是 Provider 内部方法名。两者不是同一个接口；其他工具也需以真实请求/响应确认映射和参数转换。

目前保全的是 MCP **输入 Schema**，不是全部工具的输出 Schema、失败格式或执行结果。不能因为 `tools/list` 成功，就认定所有工具的调用行为已经验证。

### Ghidra 反编译实测

研究使用本地 Ghidra `12.1.4`、Temurin JDK `21.0.13` 和由 Ghidra 自带源码编译的 macOS ARM64 `decompile`。Ghidra 的原生 headless 分析已实测成功。REA 能识别该 Ghidra Provider，但其在当前机器上的 macOS Swift 进程辅助程序仍有编译冲突，因此本次目标函数分析使用 Ghidra headless 直接完成；**不能将其描述为 REA 的全部原生调用链已恢复**。

分析结果：

| 项目                      |                          实测值 |
| ------------------------- | ------------------------------: |
| Ghidra 识别函数           |                           1,780 |
| 非自动命名的函数          | 508（含运行库；不是业务函数数） |
| 定向检索的字符串命中      |                              29 |
| 对应的代码引用            |                              62 |
| 按名称/引用筛选的候选函数 |                              13 |
| 目标函数反编译            |                 12 成功、1 超时 |

主要交叉引用索引（地址为 **Mach-O 在 Ghidra 中的虚拟地址**）：

| 函数入口      | 静态引用的关键标识                                                         | 能支持的判断                               |
| ------------- | -------------------------------------------------------------------------- | ------------------------------------------ |
| `0x100024e68` | `session_hello`、`BROWSER_MCP_SESSION_ID`                                  | 涉及会话握手/身份处理                      |
| `0x100023ab8` | `BROWSER_MCP_PROVIDER_ENDPOINT`、`BROWSER_MCP_SESSION_ID`                  | 涉及启动环境读取                           |
| `0x100026a1c` | `providers_list`                                                           | 涉及 Provider 发现/结果处理                |
| `0x10002f014` | `provider_invoke`                                                          | 涉及向 Provider 请求操作                   |
| `0x100028444` | `provider_cancel`                                                          | 涉及请求取消                               |
| `0x100031310` | `capability.negotiate`、`tabs.new`、`tab.goto`、`dom_cua.click` 等         | 涉及工具与内部方法分派；**首次反编译超时** |
| `0x1000621ec` | `protocol_mismatch`、`host_restarted`、`browser_not_found`、`stale_tab` 等 | 涉及错误类型处理                           |
| `0x10006a97c` | `provider_directory_in_root`                                               | 可读命名的协议辅助函数，已生成伪代码       |

“引用某个字符串”证明函数接触过该标识，**不等于函数内部所有分支和执行语义已经被证明**。尤其是 `0x100031310` 超时，尚不能声称已完整还原 32 工具的分派算法。

## 路径 A：复用原版 MCP，自建 Desktop Provider

### 实施边界

```text
原版 Browser Use Skill
        ↓
原版 browser-mcp（保持二进制及 MCP API 不变）
        ↓ 兼容原版的 Provider 传输与语义
自建 Desktop Browser Runtime
  ├─ Provider 通信、Session 绑定与请求路由
  ├─ Browser Controller、标签拥有权与操作授权
  ├─ 实际 Chromium 页面宿主
  ├─ DOM/CDP/坐标操作
  └─ 页面显示及用户与 Agent 共享操作的 UI
```

**技术判断：可行性高。** 静态代码清楚说明 MCP 与 Desktop Provider 之间存在协议边界；前序隔离实验曾以模拟 Provider 完成握手、浏览器发现和 `tabs.new` 请求，支持“可以不依赖 WorkBuddy Desktop 实现 Provider”的方向。

但该模拟实验**未保存完整可审计的原始报文日志到本次持久证据中**。因此当前可复核的证据主要是发布版代码与本轮 MCP 接口实测；模拟 Provider 的端到端行为应在下次研究中复验并留存报文。

此路径需要实现的不只是 `BrowserProviderRouter` 的 Socket 服务。标签生命周期、真实页面宿主、CDP、Session 授权、GUI 同步与崩溃恢复也属于需要自建的 Desktop 侧能力。

### 边界与风险

- 原版二进制仅验证了 **macOS ARM64** 产物；不能直接假定跨平台可用。
- 原版 MCP 的内部版本和 Provider 协议受第三方更新影响；需要固定版本并验证兼容。
- 需要证明每个工具的输入、输出、超时、错误、取消、多标签归属和收尾行为，才可称为高保真复用。
- `browser-mcp` 和 Skill 的重新打包/分发许可尚未确认。**技术可运行不等于获得商业分发授权。**

## 路径 B：独立实现 MCP 与 Desktop Provider

### 实施边界

```text
Agent / 我们自己的 Browser Use Skill 约定
        ↓
自建标准 MCP Server（提供约定的工具与参数合同）
        ↓ 我们自己定义的内部调用合同
自建 Desktop Browser Runtime / Provider
        ↓
真实页面、标签管理、DOM/CDP、原生显示
```

**技术判断：核心能力可实现，完整行为等价仍待验证。** 原版 MCP 已直接暴露 32 个输入 Schema；Ghidra 进一步证明工具分派、Provider 发现、请求、取消和错误处理等业务路径可定位。独立实现无需把原版 Rust 原始工程逐字恢复，也不必须采用它的私有 Unix Socket 协议。

此路径需要自主负责：

- MCP Server 的初始化、工具注册、参数校验和返回结果封装；
- `browser_id` / `tab_id`、标签认领/释放、用户与 Agent 同时操作的语义；
- 取消、并发、超时、幂等或重放、连接丢失和错误类型；
- Provider 与浏览器宿主的安全边界和生命周期；
- Skill 的行为描述与工具合同一致性。

上述事项不表示全部必须照搬 WorkBuddy 原有内部实现。路径 B 的目的可以是**行为兼容**或**实现相同能力**；两种目标的测试范围不同，现阶段尚未决定。

### 边界与风险

- `tools/list` 只暴露输入合同；复杂嵌套返回、图片内容、错误与边缘行为仍需独立测试或进一步逆向。
- 一个工具分派函数首次反编译超时。可改用更长超时、拆分调用图和针对性动态实验，但目前**尚未完成**。
- 尽管我们拥有 Desktop JavaScript 的可读发布代码，它仍不是原始 TS 工程；应区分参考其行为和直接复制第三方实现的授权问题。
- 独立实现减少了对原版 MCP 二进制的版本与分发依赖，但不自动证明已达到 WorkBuddy 的稳定性。

## 两条路径的现阶段比较

| 维度                | 路径 A：原版 MCP + 自建 Provider  | 路径 B：自建 MCP + 自建 Provider         |
| ------------------- | --------------------------------- | ---------------------------------------- |
| 技术可行性          | 高，已有部分模拟 Provider 实验    | 高，接口和关键业务入口已可研究           |
| 首个真实浏览器原型  | 预计所需工作较少                  | 需先补充 MCP 工具层                      |
| 原版 MCP 工具一致性 | 二进制天然一致，Provider 仍需对齐 | 必须按行为验证                           |
| 内部协议            | 要兼容第三方协议                  | 可以自主制定                             |
| 跨平台与后续升级    | 受第三方二进制限制                | 实现可自主控制                           |
| 版权与商业发布      | 原版二进制及 Skill 需要授权确认   | 适合独立实现，但仍需规范处理第三方材料   |
| 当前最大技术未知    | 32 工具的真实浏览器集成与异常恢复 | 输出/错误/取消语义的完整合同与实现工作量 |

**没有作出 A 或 B 的最终选择，也没有批准任何产品架构变更。** 两条路径可用同一套外部行为测试逐步比较。尤其“稳定性”必须通过真实浏览器运行、长期会话、竞态和异常恢复来验证，而不能从原版程序存在或伪代码能生成直接推出。

## 后续研究的验证清单

| 验证事项                                   | 当前状态                 | 为什么需要                     |
| ------------------------------------------ | ------------------------ | ------------------------------ |
| 固定版本、产物 SHA-256、32 工具输入 Schema | **已实测并持久化**       | 让后续研究复用相同基线         |
| Desktop JavaScript 主要模块与启动调用关系  | **已完成静态定位**       | 指导 Provider 最小实现边界     |
| Provider 握手与 `tabs.new` 的模拟实验      | **历史实验，缺持久报文** | 下次复验协议兼容并归档准确结果 |
| 原版 MCP → 自建真实页面 → 用户可见操作     | **未验证**               | 路径 A 的关键集成证据          |
| DOM CUA、坐标 CUA、截图、批处理            | **未做全工具实测**       | 验证 32 工具而非仅工具列表     |
| 会话关闭、标签保留、用户接管、多窗口       | **未验证**               | 确认所有权与 Process 生命周期  |
| 错误、取消、超时、断线、重连、并发         | **未验证**               | 稳定性的主要风险               |
| `0x100031310` 分派函数更精细的代码恢复     | **首次超时**             | 路径 B 的高保真行为研究        |
| Windows/Linux 的二进制或自建运行时         | **未验证**               | 跨平台可实施性                 |
| 原版二进制和 Skill 的使用/重分发许可       | **未确认**               | 产品化法律边界                 |

这张清单是**研究问题索引**，不是实施 Plan 或既定选型。下一次可以优先拿真实浏览器打通最小调用闭环，再针对失败部分定向分析或反编译，避免无目的地还原整份二进制。

## 证据保留与复验说明

### 已纳入仓库的长期证据

- 本报告保留版本、摘要、代码位置、模块职责、实验结论、分类和未知项。
- 相邻的 [`workbuddy-browser-mcp-provider-evidence.json`](./workbuddy-browser-mcp-provider-evidence.json) 保存**原版 MCP 标准接口实际返回的 32 个输入 Schema**，以及 **29 处字符串命中、62 条 Ghidra 代码引用、13 次反编译的成功/超时情况**。该附件是可以由机器读取和比对的观察结果。
- 附件不含第三方二进制、打包 JavaScript、原始伪代码正文、会话私密页面信息，便于在项目仓库中持久化。

### 已清理的临时分析材料

- `.wopal-space/.tmp/rea-pathb-20261114/report.txt`：原 Ghidra 探针报告，曾含有限的伪代码预览（现已清理）。
- `.wopal-space/.tmp/rea-pathb-20261114/ghidra.log`：原 Ghidra headless 执行日志（现已清理）。
- `.wopal-space/.tmp/rea-pathb-20261114/scripts/PathBProbe.java`：原目标字符串及引用关系分析脚本（现已清理）。
- `.wopal-space/.tmp/rea-ghidra-smoke-20261114/analyzeHeadless-user-temp.log`：原首次函数级反编译验收日志（现已清理）。

**上述临时材料已经清理。** 本目录保留的接口合同与核心索引不受影响，但原始日志、伪代码预览和逐次分析现场不再保留。如需复核，可在相同 SHA-256 的安装包及 Ghidra 环境中重新分析；若以后需要长期保存原始伪代码，应另行确定不进入产品仓库的归档位置和访问范围。

本地工具链安装在 `.wopal-space/envs/rea-engines/`，包含 Ghidra 12.1.4、Temurin JDK 21.0.13 和重新编译的 `mac_arm_64/decompile`。这是机器环境依赖，**不属于本报告的 Git 附件**。REA 的 Ghidra Provider 检测通过，但 REA 直接启动的 Swift 辅助组件问题仍待单独修复；本轮使用的 Ghidra headless 路线已成功。

### 对结论的使用原则

研究数据针对**WorkBuddy 5.11.3 / Browser Use 插件 1.2.2 / MCP 0.2.1 / macOS ARM64**。若原版产物更新，应先比对 SHA-256、工具合同和 Provider 行为，再判断哪些结论仍适用。

本文只形成研究基线，不修改 Active DESIGN，不创建 Plan，不对 Ellamaka Desktop 或 DSH Web Profile 的最终宿主方案作决定。
