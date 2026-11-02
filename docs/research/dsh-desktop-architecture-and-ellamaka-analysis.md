# DeepSeek Harness Desktop 架构与 Ellamaka 对照研究

> **文档定位**：本报告研究 `labs/ref-repos/deepseek-harness/apps/desktop` 的 Desktop 宿主架构，并与 Ellamaka 当前 `packages/ellamaka-desktop` 实现进行对照。本文只记录源码事实、架构分析和可复用机制，不改变 Ellamaka 正式设计。
> **设计真相源**：Ellamaka 当前目标架构仍以 `../DESIGN.md`、`../DESIGN-desktop.md`、`../DESIGN-distribution.md` 等 Active DESIGN 为准。
> **研究日期**：2026-10-30
> **主要参考源码**：`labs/ref-repos/deepseek-harness/apps/desktop/`、`labs/ref-repos/deepseek-harness/packages/subprocess/`、`labs/ref-repos/deepseek-harness/packages/shell/`、`labs/ref-repos/deepseek-harness/packages/sandbox/`，以及 Ellamaka `packages/ellamaka-desktop/`。

---

## 研究结论

DeepSeek Harness（下文简称 DSH）的 Desktop 与 Ellamaka Desktop 在一个关键方向上是一致的：**macOS GUI 应用不能假定自己继承了用户终端里的完整开发环境，因此 Desktop 必须在启动 Host 之前主动恢复用户 login shell 环境。**

DSH 并没有让每个沙箱或每次 `bash -c` 自行读取用户 shell 配置。它采用的是分层模型：

```text
Finder / Dock / launchd
        │
        ▼
Electron Desktop
        │
        ├─ 读取一次用户 login-shell 环境
        │
        ▼
Desktop Host
        │
        ├─ subprocess 层过滤敏感环境变量
        │
        ▼
sandbox runner
        │
        ▼
bash / pwsh / CLI
```

这里最重要的职责边界是：

- Desktop 负责恢复宿主用户环境。
- Host 负责持有运行环境。
- subprocess 负责构造子进程环境并做敏感信息过滤。
- sandbox 负责限制进程能力，不负责模拟用户登录或初始化 shell 配置。
- bash/pwsh 负责执行命令，不承担 Desktop 宿主环境恢复。

DSH Desktop 在这个基础问题上已经实现了大量 Ellamaka 当前 `shell-env.ts` 尚未覆盖的容错，包括多 shell fallback、安全输出解析、超时进程组清理、阻塞型 rc 配置抑制和失败诊断。

但这并不意味着 Ellamaka 应该整体替换为 DSH Desktop。Ellamaka Desktop 已经拥有自己的产品边界、Workbench Renderer、Ellamaka Server sidecar、品牌资产、发布身份、stable/beta/main/local 通道和自动更新体系。更合理的方向是**选择性吸收 DSH Desktop 的成熟底层机制，而不是把 DSH Desktop 整体作为产品壳替换 Ellamaka Desktop。**

---

## Ellamaka 当前真实 Desktop 进程模型

这次研究首先澄清一个容易混淆的点：**Ellamaka sidecar 与 Ellamaka/OpenCode fork 的 Server 并不是两个上下级进程。**

当前 Desktop Main 在 `packages/ellamaka-desktop/src/main/server.ts` 中通过：

```text
utilityProcess.fork(sidecar.js)
```

启动一个 Electron utility process。这个 utility process 就是 Ellamaka Desktop 的 sidecar。

`sidecar.ts` 随后在**同一个进程**中加载 Ellamaka Server 模块：

```text
import("virtual:opencode-server")
```

并直接调用：

```text
Server.listen(...)
```

因此真实结构是：

```text
Electron Main Process
        │
        │ utilityProcess.fork(sidecar.js)
        ▼
┌────────────────────────────────────┐
│ Ellamaka sidecar process           │
│                                    │
│ Ellamaka Server.listen()           │
│ Database / migration               │
│ Runtime / PTY                      │
│ WopalSpace integration             │
│ DSH Web profile                    │
│ DSH Tools profile                  │
└────────────────────────────────────┘
```

`sidecar` 是 Desktop 语境下对这个受 Main 管理的 Server host 进程的生命周期称呼；它不是 Server 之外的第二层后端。

这与 `DESIGN-desktop.md` 当前定义一致：Desktop sidecar 是随 Desktop 打包、由 Desktop 管生命周期的 Ellamaka Server host，并使用与 `ellamaka serve` 相同的 Server composition。

---

## DSH Desktop 的宿主结构

DSH Desktop 的应用层结构可简化为：

```text
Electron Main
    │
    ├─ Native window / menu / tray / update / account / file dialog
    │
    ├─ login-shell environment read
    │
    ▼
DesktopHostProcess
    │
    ▼
@deepseek-ai/dsh-desktop-host
    │
    ├─ DSH Web Host
    ├─ plugin runtime
    ├─ subprocess services
    └─ sandboxed shell execution
```

核心入口包括：

- `apps/desktop/src/main.ts`
- `apps/desktop/src/host-process.ts`
- `apps/desktop/src/login-shell-environment.ts`
- `apps/desktop/src/node-environment.ts`

DSH Desktop 的 Renderer、Welcome、Platform Account、Host 和 Runtime 都是 DeepSeek Harness 产品自身的一部分，不是通用 Electron 壳接口。因此它不能在不重写 Ellamaka 产品边界的情况下直接替换 Ellamaka Desktop。

---

## 为什么 Desktop 必须恢复用户 Shell 环境

### GUI 启动环境与终端环境不是一回事

在 macOS 上，从 Finder 或 Dock 启动的应用主要继承 launchd/session manager 环境。它通常不会自动拥有用户在交互式 login shell 中通过配置建立的完整环境。

典型差异包括：

```text
GUI PATH:
/usr/bin:/bin:/usr/sbin:/sbin

用户终端 PATH:
/opt/homebrew/bin
~/.local/bin
pnpm / bun / fnm / pyenv 目录
/usr/bin:/bin:/usr/sbin:/sbin
...
```

因此 Desktop 后端如果直接把 GUI `process.env` 传给 Agent shell，常见工具会出现：

```text
gh: command not found
pnpm: command not found
bun: command not found
rg: command not found
```

这不是 sandbox 主动删除 PATH，而是 sandbox 上游的 Host 从一开始就没有拿到用户终端环境。

### 为什么不让每个 bash 自己初始化

DSH shell executor 最终执行的是类似：

```text
bash -c <command>
```

它不是用户打开 Terminal 时的交互式 login shell。用户的登录 shell 还可能是 zsh、fish 或其他 shell。

如果每个工具调用都改成重新启动 `zsh -ilc` 一类 login shell，会让每条 Agent 命令重复执行 shell 初始化逻辑，包括 Homebrew、fnm、pyenv、oh-my-zsh、tmux hook、代理脚本等。这样既增加延迟，也增加副作用和故障面。

DSH 因此选择“Desktop 启动阶段读取一次，Host 与后续子进程继承”的模式。

---

## DSH Login Shell Environment 子系统

核心实现位于：

```text
apps/desktop/src/login-shell-environment.ts
```

文件定位非常直接：它专门解决 POSIX Desktop 从 session manager 启动时环境不足的问题。

### Shell 候选顺序

DSH 不只尝试一个 shell。

它首先从操作系统账户信息读取用户真实 login shell：

```text
userInfo().shell
```

然后追加固定 fallback：

```text
/bin/zsh
/bin/bash
/bin/sh
```

并去重。

例如账户 login shell 是 `/opt/homebrew/bin/fish` 时，候选可能为：

```text
/opt/homebrew/bin/fish
/bin/zsh
/bin/bash
/bin/sh
```

一个候选失败后记录原因并继续尝试下一个。全部失败才退回 Desktop 原始 inherited environment。

这与 Ellamaka 当前 `loadShellEnv()` 的“主要探测一个用户 shell，再做有限模式 fallback”不同。

### 交互式 Login Shell 探测

每个候选通过：

```text
<shell> -ilc <dump command>
```

运行。

这样会经过 login/interactive shell 的用户初始化路径，同时 stdin 关闭，使需要输入的 rc 逻辑读取 EOF，而不是永久等待。

### 主动抑制已知阻塞源

探测环境额外设置：

```text
DISABLE_AUTO_UPDATE=true
ZSH_TMUX_AUTOSTARTED=true
ZSH_TMUX_AUTOSTART=false
```

源码注释明确说明，这些变量用于避免 oh-my-zsh 更新提示和 tmux 自动启动插件阻塞非终端环境读取。

这说明 DSH 把 login-shell probe 当成正式 Desktop 基础设施，而不是简单执行一次 `env`。

### Delimiter 安全解析

DSH 不直接假定 stdout 全部都是 `env -0` 输出。

它在环境 dump 前后输出专用 delimiter：

```text
_DSH_SHELL_ENV_DELIMITER_
```

解析器只读取两个 delimiter 中间的数据。

这样即使用户 rc 文件包含：

```text
echo banner
插件启动提示
其他 stdout 输出
```

也不会污染环境变量解析结果。

### 不等待 stdout 永久关闭

用户 rc 文件可能启动后台进程，后台进程继承 stdout 后，即使 shell 本身已经退出，也可能继续保持 pipe 打开。

DSH 在检测到第二个 delimiter 后就认为环境 dump 已完整获得，而不是必须等待 stdout `close`。

对应测试明确覆盖“rc 启动后台 child 后 stdout 仍保持打开”的情况。

### 超时和进程组清理

DSH 默认每个候选的 deadline 为 10 秒，可通过 Desktop 专用配置覆盖。

probe 使用独立 process group。超时或 abort 时杀掉整个 process group，而不是只杀最外层 shell，从而避免 rc 文件启动的后台进程残留。

对应测试验证了：

- timed-out shell 会结束其后台 children；
- abort 会停止当前候选并跳过后续候选。

### Merge 规则

成功读取后，DSH 将 shell environment overlay 到 Desktop inherited environment。

大多数 shell 值优先，因为它们表达用户终端环境；但以下类别不会被 probe 结果覆盖：

- probe 自身的会话变量，如 `PWD`、`OLDPWD`、`SHLVL`、`_`；
- probe 为避免阻塞而注入的临时变量；
- `DSH_*`；
- `ELECTRON_*`。

这样可以把“用户环境”与“Desktop launcher 自己拥有的产品配置”分开。

---

## DSH 不把完整 Shell 环境写回 Electron Main

DSH `main.ts` 中启动 login-shell read 后，将结果保存在独立的：

```text
hostEnvironment
```

中。

随后 `DesktopHostProcess` 启动 Host 时显式传入这份 environment。

即：

```text
Electron process.env
        │
        ├─ Electron Main 自己继续使用
        │
        └─ login-shell merge
                  │
                  ▼
           hostEnvironment
                  │
                  ▼
            Desktop Host
```

这个边界与 Ellamaka 当前 `preferAppEnv()` 的实现不同。Ellamaka 当前会把 merge 后的环境写回 Main 的 `process.env`，再由 `createSidecarEnv()` 从 Main `process.env` 构造 sidecar 环境。

从职责边界看，DSH 的模式更清晰：**用户开发环境主要属于 Host，而不是 Electron Main 全局环境。**

---

## Host 到子进程的环境传递

### Desktop Host 明确继承 hostEnvironment

`apps/desktop/src/host-process.ts` 的 `DesktopHostProcess` 构造器接收 environment，并在启动 child 时通过 `env` 显式传入。

`apps/desktop/src/node-environment.ts` 在这个基础环境上只增加 Node/Electron Host 启动需要的变量。

DSH Desktop 因此形成了清晰链路：

```text
login-shell read
      ↓
hostEnvironment
      ↓
DesktopHostProcess
      ↓
Host process.env
```

### 私有 bundled runtime 不污染 Agent shell PATH

DSH Desktop 自带 Node、pnpm、Python 等运行时，但其文档明确说明：Desktop 私有 `runtime/bin` 只用于包安装等受控流程，不进入 PTC 和 Agent shell 从 Host 继承的 PATH。

这体现了两个不同目标：

- 用户 CLI 查找应尊重用户真实宿主环境；
- 产品内置工具链应通过明确路径使用，不用偷偷改 Agent shell 的 PATH。

---

## Subprocess 层负责敏感环境过滤

核心实现位于：

```text
packages/subprocess/subprocess/src/index.ts
```

其 `scrubbedParentEnv()` 定义了 Harness 子进程的 canonical base environment。

基本逻辑是：

```text
Host process.env
      ↓
删除 credential-shaped names
删除 DSH_* names
保留 PATH / HOME / locale / proxy 等普通运行环境
      ↓
scrubbed parent environment
```

然后具体调用者的显式 `env` 再 overlay 上去。

因此安全模型不是“子进程原样继承所有用户变量”，而是：

```text
宿主环境
   ↓
统一 scrub
   +
调用者显式 env
   ↓
最终 child environment
```

这使 `PATH`、`HOME`、locale、代理等普通 CLI 运行信息可以自然继承，同时 credential-shaped environment 不会无意下发到每个 Agent child。

---

## Sandbox 不负责初始化环境

DSH 的 shell 与 sandbox 分成两层。

普通 Bash executor 位于：

```text
packages/shell/bash-local/src/index.ts
```

它通过 subprocess service 启动：

```text
bash -c <command>
```

Sandbox Bash executor 位于：

```text
packages/shell/bash-sandbox/src/index.ts
```

它继承 LocalBashExecutor，只是在真正执行之前把原始 argv 交给：

```text
ctx.sandbox.confine(...)
```

例如 macOS 最终可能变为：

```text
sandbox-exec <policy> -- bash -c <command>
```

环境仍由同一 subprocess 路径构造。

因此 DSH 的职责关系是：

```text
subprocess = 环境、spawn、进程生命周期
sandbox    = capability confinement
shell      = 命令语义
```

这解释了为什么“让 sandbox 自己读取 ~/.zshrc”不是 DSH 的设计方向：它会把宿主环境初始化、凭据过滤和 capability confinement 混到一个层里。

---

## DSH Desktop 的自动更新能力

DSH Desktop 自己拥有完整自动更新体系，并不是依赖外部 Web 应用更新。

核心模块包括：

```text
apps/desktop/src/update-coordinator.ts
apps/desktop/src/update-schedule.ts
apps/desktop/src/update-journal.ts
apps/desktop/src/update-attention.ts
apps/desktop/src/mandatory-update-*.ts
apps/desktop/src/update-window.ts
```

底层同样使用 `electron-updater`，但在其上建立了更完整的状态机和安装前协调：

```text
check
  ↓
available
  ↓
download
  ↓
verifying
  ↓
ready
  ↓
install
```

其中 `DesktopUpdateCoordinator` 明确分离：

- check；
- download；
- install；
- download progress；
- 安装前 Host/task 检查和停止；
- stale version confirmation 检查；
- 更新失败状态；
- updater listener 生命周期。

DSH 还配套实现 mandatory update、用户注意力提示、update journal 和 installed-update qualification。

这套能力值得作为 Ellamaka updater 的成熟参考，但 DSH 自己的 product identity、feed、强制更新策略和 Host 停止语义不能直接复制到 Ellamaka。

---

## DSH Desktop 的打包、品牌与平台能力

DSH Desktop 并非一个无品牌的通用壳。它包含大量 DeepSeek Harness 产品事实：

- `productName: DeepSeek Harness`；
- `dsh://` protocol；
- DeepSeek 自己的 macOS/Windows 图标；
- DeepSeek 的 Welcome、Account、Platform UI；
- DeepSeek release/update channel；
- 自己的签名、公证和 Windows installer 流程；
- 自己的 runtime tree 和 bundled dependencies；
- 自己的 Host 与 Web application。

它也拥有非常完整的平台工程能力，例如：

- macOS hardened runtime、entitlements、notarization；
- Windows signing；
- Windows installer UI；
- tray icon；
- installed-update verification；
- crash/fatal recovery；
- quit confirmation；
- native directory picker；
- application menu；
- Platform account isolated WebContentsView。

这些证明 DSH Desktop 是成熟产品宿主，但也说明它不是可以直接嵌进 Ellamaka 的中性 Desktop SDK。

---

## Ellamaka Desktop 已有产品资产

Ellamaka 当前 Desktop 已经拥有自己的产品级边界。

### 品牌与包身份

`packages/ellamaka-desktop/electron-builder.config.ts` 已定义：

- `Ellamaka` / `Ellamaka Beta` / `Ellamaka Main`；
- `ai.ellamaka.desktop*` appId；
- `ellamaka://` protocol；
- `resources/icons/icon.icns`；
- `resources/icons/icon.ico`；
- Ellamaka artifact 命名。

Renderer 还使用 Ellamaka 自己的 favicon、Mark 与 text logo。

### 自动更新与发布通道

Ellamaka 已经有自己的 `electron-updater` 集成和发布规则：

```text
stable → ellamaka-desktop/latest
beta   → ellamaka-desktop/beta/latest
main   → updater disabled
local  → updater disabled
```

这些规则由 `DESIGN-distribution.md` 作为正式真相源定义。

因此 DSH updater 可以贡献机制，但不能替代 Ellamaka 的 release identity、channel 和 feed。

### Workbench 与 Sidecar

Ellamaka Renderer 是 `ellamaka-app` Workbench，不是 DSH Web UI。

Ellamaka sidecar 是产品自己的 Ellamaka Server host，同时承载 Runtime、WopalSpace、PTY、DSH Web/Tools integration。把它替换成 `dsh-desktop-host` 会改变当前正式 Desktop/Server architecture，而不仅仅是更换 Electron 壳。

---

## Ellamaka 与 DSH Desktop 对照

| 维度 | Ellamaka 当前实现 | DSH Desktop 当前实现 | 研究判断 |
|---|---|---|---|
| 产品 Renderer | Ellamaka Workbench | DSH Web application | 各自产品层，不应互换 |
| Desktop Host | Ellamaka Server sidecar | `dsh-desktop-host` | 各自产品 Runtime owner |
| login-shell env | `shell-env.ts` 简化 probe | 独立成熟 subsystem | DSH 明显更完整，值得移植机制 |
| Host env ownership | merge 后写回 Main `process.env` | 独立 `hostEnvironment` | DSH 边界更干净 |
| subprocess env | sidecar/engine 各自消费 `process.env` | canonical scrub + explicit overlay | DSH 分层更统一 |
| sandbox | 已接 DSH sandbox | DSH native architecture | Ellamaka 不需要另造 sandbox env 初始化 |
| updater | 已有 channel-aware `electron-updater` | 更完整 coordinator/journal/mandatory flow | 可选择性吸收机制 |
| packaging | Ellamaka 自己的 build/release identity | DSH 自己的完整 packaging pipeline | 保持 Ellamaka ownership，择优参考 |
| 品牌 | Ellamaka icon/logo/appId/protocol | DeepSeek Harness branding | 必须保持产品独立 |
| signing/notarization | Ellamaka 当前有自己的发布路径 | DSH 更深入 | 可作为后续工程参考 |

---

## 对 Issue #263 的直接启示

Issue #263 暴露的不是“sandbox 架构错误”，而是 Ellamaka Desktop 顶层宿主环境恢复过于脆弱。

当前故障链可概括为：

```text
Finder/Dock minimal env
      ↓
Ellamaka shell probe 一次失败
      ↓
Main PATH 保持 GUI minimal
      ↓
createSidecarEnv()
      ↓
sidecar PATH 仍 minimal
      ↓
DSH subprocess 保留 PATH
      ↓
sandbox bash 找不到用户 CLI
```

因此：

1. sandbox 并没有把正确 PATH 删除；
2. `scrubbedParentEnv()` 也不是根因，因为它本来就保留 PATH；
3. 根因在更上游的 Desktop login-shell bootstrap；
4. 单次 transient probe failure 会污染整个 Desktop 运行期；
5. 当前日志不足导致具体 transient trigger 难以事后还原。

DSH 的实现直接提供了一组已经被专门测试的解决思路：

- account login shell + 多候选 fallback；
- async probe；
- delimiter parsing；
- 已知 rc 阻塞抑制；
- per-candidate timeout；
- process-group cleanup；
- 明确失败诊断；
- 共享一次成功的 host environment；
- Host env 与 Electron Main env 分离。

### 关于环境缓存

DSH 当前 Desktop 没有通过“把完整 login-shell environment 持久化到 userData”解决可靠性问题。

这一点对 #263 的候选方案很重要。完整 shell env 可能包含 API key、token 或其他 process-only secrets；把它原样缓存到磁盘会引入新的凭据持久化风险。

如果 Ellamaka 未来确实需要 last-known-good cache，应把它设计为独立安全机制，只持久化明确允许的安全变量，而不能直接序列化完整 shell environment。

---

## 可复用机制与不可直接复用部分

### 高价值可复用机制

以下能力与 Ellamaka 产品身份无强绑定，具有较高移植价值：

1. Desktop login-shell environment subsystem。
2. account shell + fixed fallback candidates。
3. delimiter-based env parsing。
4. rc blocking suppression。
5. timeout/abort 的 process-group cleanup。
6. 单次共享 Host environment。
7. Electron Main 与 Host environment 分离。
8. subprocess 的 scrub + explicit env overlay 思路。
9. updater 中 check/download/install 的显式状态机与 stale confirmation 防护。
10. update journal、installed-update verification、quit/task coordination 等工程模式。
11. crash/fatal recovery 和平台发布验证的测试思路。

### 不应直接整体搬入 Ellamaka 的产品部分

以下内容是 DSH Desktop 产品自身，不是中性基础设施：

- DSH Renderer / Web application；
- DeepSeek Welcome 和账号体系；
- `dsh-desktop-host` 作为 Ellamaka Server 的替代品；
- DeepSeek product name、icons、protocol、feed；
- DSH 自己的 profile/runtime ownership；
- DSH release identity；
- 为 DSH 产品语义编写的 mandatory update policy。

---

## 推荐的长期关系

从本次源码对照看，更合理的关系不是：

```text
Ellamaka Desktop ← 整体替换为 DSH Desktop
```

而是：

```text
              DSH Desktop
           成熟机制参考源
                  │
                  │ 选择性 port / 提炼
                  ▼
            Ellamaka Desktop
   ┌──────────────┼──────────────┐
   │              │              │
Workbench    Ellamaka sidecar   Release identity
品牌/UI       Server + DSH       updater/channel
   │              │              │
   └──────────────┴──────────────┘
            Ellamaka 产品所有
```

如果未来越来越多 DSH Desktop 通用机制被 Ellamaka 复用，可以再评估把这些通用能力提炼成共享 package。这个方向需要独立设计，不能在一次 bug fix 中顺手完成。

---

## 源码证据索引

### DeepSeek Harness

- `labs/ref-repos/deepseek-harness/apps/desktop/src/login-shell-environment.ts`
  - login shell candidates、probe、delimiter parsing、timeout/abort、merge。
- `labs/ref-repos/deepseek-harness/apps/desktop/tests/login-shell-environment.spec.ts`
  - fallback、rc stdout、background child、timeout group cleanup 等行为测试。
- `labs/ref-repos/deepseek-harness/apps/desktop/src/main.ts`
  - login-shell read、`hostEnvironment`、Host startup、Desktop lifecycle。
- `labs/ref-repos/deepseek-harness/apps/desktop/src/host-process.ts`
  - Host child lifecycle 和显式 environment 传递。
- `labs/ref-repos/deepseek-harness/apps/desktop/src/node-environment.ts`
  - Host Node mode environment overlay。
- `labs/ref-repos/deepseek-harness/packages/subprocess/subprocess/src/index.ts`
  - `scrubbedParentEnv()`。
- `labs/ref-repos/deepseek-harness/packages/subprocess/subprocess-local/src/spawn.ts`
  - child env merge 和 spawn ownership。
- `labs/ref-repos/deepseek-harness/packages/shell/bash-local/src/index.ts`
  - local bash execution 与 subprocess seam。
- `labs/ref-repos/deepseek-harness/packages/shell/bash-sandbox/src/index.ts`
  - sandbox wrapping 与 LocalBashExecutor 复用。
- `labs/ref-repos/deepseek-harness/packages/sandbox/sandbox-local/src/`
  - macOS Seatbelt / local confinement provider。
- `labs/ref-repos/deepseek-harness/apps/desktop/src/update-coordinator.ts`
  - updater state and install coordination。
- `labs/ref-repos/deepseek-harness/apps/desktop/scripts/electron-builder-config.mjs`
  - product identity、icon、signing、notarization、runtime packaging、update feed。
- `labs/ref-repos/deepseek-harness/apps/desktop/README.zh.md`
  - Desktop product behavior、bundled runtime、update、platform ownership。

### Ellamaka

- `projects/ellamaka/packages/ellamaka-desktop/src/main/shell-env.ts`
  - 当前 login-shell probe。
- `projects/ellamaka/packages/ellamaka-desktop/src/main/server.ts`
  - `utilityProcess.fork(sidecar.js)`、`createSidecarEnv()`。
- `projects/ellamaka/packages/ellamaka-desktop/src/main/sidecar.ts`
  - 同进程 `Server.listen()`、DSH Web/Tools activation。
- `projects/ellamaka/packages/ellamaka-desktop/src/main/updater.ts`
  - Ellamaka auto-update。
- `projects/ellamaka/packages/ellamaka-desktop/electron-builder.config.ts`
  - Ellamaka product identity、icons、protocol、feed。
- `projects/ellamaka/docs/DESIGN-desktop.md`
  - Desktop/sidecar 正式目标架构。
- `projects/ellamaka/docs/DESIGN-distribution.md`
  - Desktop release identity、channel 和 update ownership。

---

## 最终判断

DSH Desktop 对 Ellamaka 最有价值的不是“另一个完整 Desktop 产品”，而是它在 Electron Host、login-shell、subprocess、更新、平台生命周期和发布验证上已经沉淀的一批成熟工程机制。

Ellamaka 当前的核心产品价值仍然在自己的 Workbench、Ellamaka Server、WopalSpace integration、Runtime/PTY、发布体系与品牌体验。Desktop 基础设施应尽量少重复踩 DSH 已经解决的问题，但吸收方式应保持 Ellamaka 的现有产品边界和正式设计所有权。
