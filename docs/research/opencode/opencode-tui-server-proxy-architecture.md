# OpenCode TUI 模式 Server-Proxy 架构分析

> TUI 默认模式（无 `--port`）不会启动 HTTP 端口，Server 运行在 Worker 子线程内，TUI 主线程通过结构化消息传递 RPC 与 Server 通信——零网络开销的进程内部通道。

---

## 一、进程模型

TUI 默认模式启动两个进程：

```
┌─────────────────────────────────┐
│  主进程 (process_role=main)      │
│  thread.ts                      │
│  ┌───────────┐  postMessage   │
│  │ TUI (App)  │──────────────┐ │
│  │ SolidJS    │              │ │
│  └───────────┘              ▼ │
│                      ┌──────────────┐
│                      │  Worker 子进程 │
│                      │  worker.ts     │
│                      │  (role=worker) │
│                      │  ┌──────────┐  │
│                      │  │  Server   │  │
│                      │  │  (Hono)   │  │
│                      │  └──────────┘  │
│                      └──────────────┘
└─────────────────────────────────┘
```

- **主进程** (`thread.ts`): TUI 渲染（SolidJS/OpenTUI），负责 UI 展示和用户交互
- **Worker 子进程** (`worker.ts`): 运行完整 Server 实例（Hono app），处理会话、消息、工具调用、SDK 事件等所有后端逻辑

两个日志文件分别来自两个进程各自的 `Log.init()` 调用。

---

## 二、RPC 协议层

两台 "进程" 之间通过 Worker `postMessage` + 结构化 JSON 消息进行双向 RPC。

**源码**: `packages/opencode/src/util/rpc.ts` (64 行)

### 消息类型

| 消息类型      | 方向        | 含义                                |
| ------------- | ----------- | ----------------------------------- |
| `rpc.request` | 主 → Worker | RPC 方法调用（method + input + id） |
| `rpc.result`  | Worker → 主 | RPC 方法返回值（result + id）       |
| `rpc.event`   | Worker → 主 | 事件推送（GlobalBus 事件广播）      |

### RPC 方法注册（Worker 端）

**源码**: `packages/opencode/src/cli/cmd/tui/worker.ts:48-97`

```ts
export const rpc = {
  fetch(input) {
    // 核心 API 调用：直接走 Server.Default().app.fetch(request)
    return Server.Default().app.fetch(request)
  },
  server(input) {
    // 仅在 --port 时调用：绑定 TCP 端口
    server = await Server.listen(input)
    return { url: server.url.toString() }
  },
  snapshot() {
    // 堆快照
    return writeHeapSnapshot("server.heapsnapshot")
  },
  checkUpgrade(input) { ... },
  reload() { ... },
  shutdown() { ... },
}
Rpc.listen(rpc)
```

关键：`Rpc.listen(rpc)` 在 Worker 全局作用域执行，注册 `onmessage` 处理器（`rpc.ts:6`）。Worker 一旦启动即处于就绪状态，主进程随时可通过 `client.call()` 发起调用。

### RPC 客户端（主进程端）

**源码**: `packages/opencode/src/cli/cmd/tui/thread.ts:157`

主进程创建 RPC 客户端后，通过 `client.call("fetch", ...)` 调用 Worker 方法：

```ts
const client = Rpc.client<typeof rpc>(worker)
```

---

## 三、Fetch 代理：绕过 HTTP 的 API 调用

这是整个架构最有价值的部分。TUI 代码内部统一使用标准 `fetch()` 进行 API 调用，主进程通过 `createWorkerFetch()` 拦截所有 `fetch()`，将其转换为 RPC 调用：

**源码**: `packages/opencode/src/cli/cmd/tui/thread.ts:32-48`

```ts
function createWorkerFetch(client: RpcClient): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init)
    const body = request.body ? await request.text() : undefined
    const result = await client.call("fetch", {
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers.entries()),
      body,
    })
    return new Response(result.body, {
      status: result.status,
      headers: result.headers,
    })
  }
}
```

调用链：

```
TUI 代码 fetch("http://opencode.internal/session/...")
  → createWorkerFetch 拦截
  → client.call("fetch", { url, method, headers, body })
  → Worker postMessage (rpc.request)
  → worker.ts rpc.fetch() 处理
  → Server.Default().app.fetch(request)
  → Hono 路由 → 业务逻辑
  → Response
  → Worker postMessage (rpc.result)
  → client 解析 → 返回标准 Response 对象
```

`http://opencode.internal` 是伪地址，仅作为 fetch API 的形式参数，实际从未通过网络传输。

---

## 四、Server 生命周期

### Server 全局单例

**源码**: `packages/opencode/src/server/server.ts`

`Server.Default()` 是全局单例（Effect Layer），Worker 启动后首次 `fetch` 调用即完成初始化。Server 实例化包括：

- Hono app 路由注册（session、message、tool、file 等全部 API 端点）
- Effect 运行时初始化（Config、Bus、Instance 等 Effect Service）
- 中间件链（认证、CORS、错误处理等）

### 双模式对比

| 维度              | TUI 默认模式                 | serve 模式 (`--port`)        | attach 模式             |
| ----------------- | ---------------------------- | ---------------------------- | ----------------------- |
| Server 实例       | Worker 内 `Server.Default()` | Worker 内 `Server.Default()` | 外部进程的远端 Server   |
| 网络端口          | **无**                       | `Bun.serve()` 绑定           | 远端已有                |
| API 调用          | Worker RPC 代理              | HTTP (localhost)             | HTTP (远端)             |
| 启动命令          | `ellamaka` (默认)            | `ellamaka serve --port 4096` | `ellamaka attach <url>` |
| `Server.listen()` | 不调用                       | 调用（绑定端口）             | 已运行                  |
| `process_role`    | main + worker                | main + worker                | main only（无 worker）  |

**`external` 判定逻辑** (`thread.ts:191-197`):

```ts
const external =
  process.argv.includes("--port") ||
  process.argv.includes("--hostname") ||
  process.argv.includes("--mdns") ||
  network.mdns ||
  network.port !== 0 ||
  network.hostname !== "127.0.0.1"
```

`external=true` → 启动 HTTP 端口；`external=false` → 纯 Worker RPC 通信。

---

## 五、全局事件广播

Worker 内部的 `GlobalBus` 事件通过 RPC 事件机制推送到主进程：

**Worker 端** (`worker.ts:42-44`):

```ts
GlobalBus.on("event", (event) => {
  Rpc.emit("global.event", event)
})
```

**主进程端** (`thread.ts:50-58`):

```ts
function createEventSource(client: RpcClient): EventSource {
  return {
    subscribe: async (handler) => {
      return client.on<GlobalEvent>("global.event", (e) => handler(e))
    },
  }
}
```

所有 Server 端产生的 SDK 事件（工具调用、消息创建、步骤开始/结束等）通过此通道实时推送至 TUI，实现 UI 的流式渲染。

---

## 六、技术要点

1. **零网络开销**: Worker postMessage 是内存消息传递，无 TCP 握手、无序列化到网络层的开销。JSON 序列化开销依然存在（Worker 通道要求 structured clone），但比 HTTP 少一层协议栈。

2. **同构架构**: `Server.Default()` 与 `serve` 模式共用一个 Server 实现，代码 100% 复用。唯一的模式差异在传输层（RPC vs HTTP），不在业务逻辑。

3. **isolation**: Worker 子进程 crash 不会导致主进程 TUI 死亡。`thread.ts:147-155` 注册了 Worker 错误处理，TUI 可优雅降级或重启。

4. **认证处理**: Worker 端 `getAuthorizationHeader()` (`worker.ts:99-103`) 读取 `OPENCODE_SERVER_PASSWORD` flag，在 fetch 代理中自动注入 Authorization header——主进程发起的请求在进入 Server 前已完成认证。

5. **两条日志的原因**: 主进程和 Worker 进程各自独立调用 `Log.init()`。Worker 日志常包含 `service=server-proxy`、`directory=...` 等 Server 内部服务的生命周期日志。

---

## 七、关键源码索引

| 文件                    | 行      | 职责                                                       |
| ----------------------- | ------- | ---------------------------------------------------------- |
| `cli/cmd/tui/thread.ts` | 32-48   | fetch 代理：将 HTTP fetch 转为 Worker RPC                  |
| `cli/cmd/tui/thread.ts` | 50-58   | 事件代理：将 Worker 事件转为 EventSource 接口              |
| `cli/cmd/tui/thread.ts` | 60-256  | TUI 主流程：Worker 启动 → RPC 建立 → TUI 渲染              |
| `cli/cmd/tui/thread.ts` | 74-109  | `$0` 默认命令定义 → 无子命令时命中此命令                   |
| `cli/cmd/tui/thread.ts` | 191-209 | external 判定 + transport 构造                             |
| `cli/cmd/tui/thread.ts` | 199-203 | `--port` 时：启动 HTTP Server + 返回 URL                   |
| `cli/cmd/tui/thread.ts` | 205-209 | 无 `--port` 时：Worker fetch + 内部事件                    |
| `cli/cmd/tui/worker.ts` | 1-104   | Worker 完整流程                                            |
| `cli/cmd/tui/worker.ts` | 48-95   | RPC 方法注册（fetch/server/snapshot 等）                   |
| `cli/cmd/tui/worker.ts` | 60      | Server 请求处理入口：`Server.Default().app.fetch(request)` |
| `cli/cmd/tui/worker.ts` | 72-76   | `server` RPC：仅在 `--port` 模式下调用 `Server.listen()`   |
| `util/rpc.ts`           | 1-64    | RPC 协议实现（request/result/event 三种消息）              |
| `cli/cmd/tui/attach.ts` | -       | attach 模式：纯 TUI 客户端（不启动 Worker/Server）         |
