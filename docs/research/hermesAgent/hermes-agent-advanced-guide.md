# Hermes Agent 高级使用指南

> **版本**: v0.8.0  
> **目标受众**: 进阶用户、开发者、架构研究者  
> **研究日期**: 2026-04-17

---

## 架构概览

### 核心组件关系图

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              用户交互层                                      │
├─────────────────────────────────────────────────────────────────────────────┤
│  CLI TUI     │  Gateway      │  ACP Server  │  API Server  │  MCP Server   │
│  (cli.py)    │  (gateway/)   │  (acp/)      │  (:8642)     │  (stdio)      │
│  Rich + PT   │  15+ 平台     │  VS Code/Zed │  OpenAI API  │  Claude Code  │
└───────┬──────┴───────┬───────┴───────┬───────┴───────┬──────┴───────┬───────┘
        │              │               │               │               │
        ▼              ▼               ▼               ▼               ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Agent 核心                                      │
│                         run_agent.py:7528-10346                              │
│                        (~2800 行同步 while 循环)                              │
├─────────────────────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌──────────────────┐  ┌──────────────┐  ┌─────────────┐   │
│  │ Iteration   │  │ Error Recovery   │  │ Prompt Cache │  │ Context     │   │
│  │ Budget      │  │ Matrix (20+)     │  │ Freezing     │  │ Compressor  │   │
│  │ (90 次)     │  │                  │  │              │  │             │   │
│  └─────────────┘  └──────────────────┘  └──────────────┘  └─────────────┘   │
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                        Tool Registry (40+ 工具)                       │   │
│  │  Web │ Terminal │ File │ Browser │ Vision │ Skills │ Memory │ MCP │   │
│  │  TTS │ Delegate │ Cron │ HomeAssistant │ RL │ Messaging │ Clarify │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
        │              │               │               │               │
        ▼              ▼               ▼               ▼               ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              存储层                                          │
├─────────────────────────────────────────────────────────────────────────────┤
│  SessionDB   │  MemoryStore  │  SkillStore  │  Trajectory  │  Checkpoint   │
│  (SQLite     │  (MEMORY.md   │  (SKILL.md   │  (JSONL      │  (Git         │
│   + FTS5)    │   + USER.md)  │   per skill) │   samples)   │   snapshots)  │
└─────────────────────────────────────────────────────────────────────────────┘
        │              │               │               │               │
        ▼              ▼               ▼               ▼               ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              插件层                                          │
├─────────────────────────────────────────────────────────────────────────────┤
│  Hook System │  Memory Provider │  Context Engine │  Custom Plugin │        │
│  (6 hooks)   │  (Honcho/Mem0)   │  (LCM/自定义)   │  (Python/YAML) │        │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 文件依赖链

```
tools/registry.py  (无依赖 — 所有工具文件导入此模块)
       ↓
tools/*.py  (每个文件调用 registry.register() 注册工具)
       ↓
toolsets.py  (定义工具集组合，导入 tools/registry 触发注册)
       ↓
model_tools.py  (_discover_tools() 导入所有工具文件)
       ↓
run_agent.py  (AIAgent 核心，导入 model_tools)
       ↓
cli.py / gateway/run.py / batch_runner.py  (入口点)
```

---

## Agent Loop 机制

### 迭代预算（IterationBudget）

**替代传统 `max_iterations` 的线程安全计数器**：

```python
class IterationBudget:
    max_total: int = 90       # 默认最大轮次
    remaining: int            # 剩余预算
    used: int                 # 已使用轮次
    
    def consume() -> bool     # 消耗预算，返回是否成功
    def refund()              # 不消耗预算（用于 execute_code）
```

**关键特性**：
- 默认 **90 次** tool-calling 轮次
- `execute_code`（编程式工具调用）**不消耗预算**（refund）
- 预算耗尽时 **Grace Call**：注入 "总结已完成工作" 消息，给一次额外机会
- 子代理有独立预算（默认 50）

**Grace Call 流程**：

```
预算耗尽 → 设置 _budget_grace_call = True → 
注入 User Message: "You have reached the iteration limit. 
Summarize what you've accomplished..." → 
最后一次 API 调用 → 返回摘要 → 结束对话
```

### 错误恢复矩阵（20+ 策略）

| 错误类型 | 恢复策略 | 代码位置 |
|---------|---------|----------|
| Thinking signature invalid (Anthropic 400) | 剥离 `reasoning_details` 重试（一次性） | run_agent.py:~8500 |
| Context length exceeded | 降低 context_length tier + 压缩历史 | run_agent.py:~8600 |
| Max tokens too large | 降低 max_tokens 到可用值 | run_agent.py:~8550 |
| 413 payload too large | 压缩历史（最多 3 次） | run_agent.py:~8520 |
| 429 rate limit | Credential pool 轮换 → 切换 fallback provider | run_agent.py:~8400 |
| Anthropic long-context tier | 将 context 降到 200K（标准层级） | run_agent.py:~8700 |
| Truncated response (length finish) | 继续请求（最多 3 次）→ 回退 | run_agent.py:~8300 |
| 推理耗尽（只有 think 没有回答） | 检测 think tag → 用户友好提示 → 建议 | run_agent.py:~8200 |
| Invalid tool name | Auto-repair（模糊匹配）→ 返回错误让模型自纠正 | model_tools.py:~150 |
| Invalid JSON args | 返回 JSON 修复建议给模型（最多 3 次） | model_tools.py:~200 |
| Empty response | Thinking prefill 重试 → 空响应重试（3 次）→ fallback | run_agent.py:~8100 |
| UnicodeEncodeError | 剥离 surrogate characters → 重试 | run_agent.py:~8000 |
| 非可重试客户端错误 | 尝试 fallback → 失败则终止 | run_agent.py:~7900 |
| 连接死亡 | 自动清理 TCP dead connection → 重建 | run_agent.py:~7600 |

### Parallel Tool Execution

**并行安全工具判定**：

```python
_PARALLEL_SAFE_TOOLS = {
    "read_file", "search_files", "session_search",
    "vision_analyze", "web_search", "web_extract",
}

_PATH_SCOPED_TOOLS = {
    "read_file", "write_file", "patch"
}
```

**并行执行条件**：
1. 不包含 `clarify`（需要用户交互）
2. 所有工具是只读或路径不冲突
3. 同一批次最多 8 个并发线程

**执行逻辑**：

```python
if all(tool in _PARALLEL_SAFE_TOOLS for tool in batch):
    # 完全并行
    ThreadPoolExecutor(max_workers=8).map(execute_tool, batch)
elif all(path_non_overlapping(batch)):
    # 路径隔离并行
    ThreadPoolExecutor(max_workers=len(batch)).map(execute_tool, batch)
else:
    # 串行执行
    for tool in batch:
        execute_tool(tool)
```

### Prompt Cache Freezing 原理

**设计目标**：确保 Anthropic prefix cache 命中率，多轮对话 input token 成本降低约 75%。

**实现机制**：

| 原则 | 实现 | 影响 |
|------|------|------|
| System prompt 冻结不变 | `_cached_system_prompt` 首次构建后永不重建 | Cache prefix 完全稳定 |
| Memory 写入不刷新 prompt | memory tool 立即写 MEMORY.md，但 system prompt 不更新 | 避免 Cache Miss |
| Skills 注入 user message | `skill_manage` 结果作为 user message 追加 | 不触碰 system prompt |
| Plugin 上下文注入 user message | `pre_llm_call` hook 结果追加到当前 user message | 不修改 system prompt |
| Anthropic cache 自动启用 | `apply_anthropic_cache_control()` 在 system + 最后 3 条注入 breakpoints | Cache 有效 |

**Cache Breakpoints 位置**：

```
System Prompt (breakpoint 1)
User Message 1
Assistant Message 1
Tool Result 1
...
User Message N-2 (breakpoint 2)
Assistant Message N-2
User Message N-1 (breakpoint 3)
Assistant Message N-1
User Message N (breakpoint 4)
```

**代码位置**：`agent/prompt_caching.py`

---

## 多 Agent 委托

### delegate_tool 全流程

**位置**：`tools/delegate_tool.py`（1103 行）

```
父代理调用 delegate_task(goal, context, toolsets, model, tasks)
    ↓
_build_child_agent() — 构建子代理实例
    │  • 独立 AIAgent 实例
    │  • 独立 iteration budget（默认 50）
    │  • 隔离工具集（移除 delegate/clarify/memory/send_message/execute_code）
    │  • 深度限制 MAX_DEPTH=2
    │  • 独立 model/provider/credentials
    │  • Credential 租赁：pool.acquire_lease()
    ↓
执行模式:
    ├─ 单任务: 直接 child.run_conversation()
    └─ 多任务: ThreadPoolExecutor(max_workers=N) 并行
    ↓
_run_single_child():
    • 心跳线程: 每 30s 更新父代理活动状态
    • 进度回调: 子代理工具调用实时推送父代理 UI
    • Credential 释放: pool.release_lease()
    ↓
结果汇总 → JSON → 返回父代理的 tool result
```

### 委派约束

| 约束 | 设计原因 |
|------|---------|
| 子代理不共享对话历史 | 只看 goal + context，避免污染父代理状态 |
| 阻塞等待 | 父代理等所有子代理完成，保证任务完整性 |
| 不可递归委派 | 移除 delegate_task，深度限制 2 |
| 不可交互用户 | 移除 clarify，子代理必须自主完成 |
| 不写共享内存 | 移除 memory，避免跨代理记忆污染 |
| 不用 execute_code | 要求逐步推理，而非写脚本批量执行 |

### Background Review Agent

**位置**：`run_agent.py:_spawn_background_review()`

**流程**：

```
主代理完成响应 → 
后台线程启动审查 Agent →
    继承相同 model + tools + 对话历史 →
    注入审查 prompt →
    最多 8 次工具调用 →
    扫描 memory/skill 操作 →
    摘要推送用户界面
```

**目的**：实现 agent 自我学习——自动判断是否应将本次对话经验写入 MEMORY.md 或创建新 Skill。

---

## Gateway 守护进程模式

### Gateway 架构

**设计哲学**：Agent 永远在后台运行（Gateway 常驻），前端只负责交互。同一个 agent 同时服务所有平台，共享 memory、skills、会话状态。

```
┌─────────── 前端层（无状态）───────────────┐
│  CLI TUI │  Telegram Bot │  Discord Bot │  Slack │  WebUI │
└─────┬─────┴───────┬───────┴───────┬──────┴───┬────┴───┬────┘
      ▼             ▼               ▼          ▼        ▼
┌──────────────── Gateway 运行时 ────────────────────────┐
│  Session Store (SQLite + FTS5 全文搜索)                  │
│  Platform Adapters (15+ platforms)                      │
│  ┌────────────────────────────────────────────────────┐ │
│  │  AIAgent (共享核心)                                  │ │
│  │  ├── Tool Registry (40+ tools)                     │ │
│  │  ├── Context Compressor                            │ │
│  │  ├── Memory Manager                                │ │
│  │  ├── Skill System                                  │ │
│  │  └── Plugin Hooks                                  │ │
│  └────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────┘
```

### 各平台配置步骤

#### Telegram Bot

1. 创建 Bot：https://t.me/BotFather → `/newbot` → 获取 Token
2. 配置：
   ```bash
   hermes setup gateway
   # 或手动设置 .env:
   TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
   TELEGRAM_ALLOWED_USERS=12345678,87654321  # 允许的用户 ID
   ```
3. 启动：
   ```bash
   hermes gateway
   ```

#### Discord Bot

1. 创建 App：https://discord.com/developers/applications
2. 创建 Bot → 获取 Token
3. OAuth2 URL Generator → 勾选 `bot` + `applications.commands` → 添加到服务器
4. 配置：
   ```env
   DISCORD_BOT_TOKEN=...
   DISCORD_ALLOWED_USERS=...
   ```
5. Slash Commands 自动注册

#### Slack App

1. 创建 App：https://api.slack.com/apps
2. Bot Token (`xoxb-`) + App Token (`xapp-`)
3. OAuth Scopes:
   ```
   chat:write, app_mentions:read, channels:history, 
   groups:history, im:history, im:read, im:write, users:read
   ```
4. Socket Mode 启用
5. 配置：
   ```env
   SLACK_BOT_TOKEN=xoxb-...
   SLACK_APP_TOKEN=xapp-...
   ```

#### WhatsApp

两种模式：
- **Bot 模式**：使用独立号码（推荐）
- **Self-chat 模式**：使用个人号码与自己聊天

配置：
```bash
hermes whatsapp  # 交互式设置向导 + QR 码配对
```

#### Signal

需要 `signal-cli` 或 `signald`：

```env
SIGNAL_ACCOUNT=+1234567890
SIGNAL_HTTP_URL=http://localhost:8080
SIGNAL_ALLOWED_USERS=...
```

### Session 管理

**Session Key 格式**：

```
<platform>:<channel_id>:<user_id>

# 示例:
telegram:12345678:987654321        # Telegram 私聊
telegram:-10012345678:987654321    # Telegram 群组（负 ID）
discord:123456789:987654321        # Discord 私聊
discord:123456789:987654321:thread_abc  # Discord Thread
slack:C12345678:U987654321         # Slack Channel + User
```

**Session 持久化**：
- SQLite + FTS5 全文搜索
- 会话 ID 链接消息历史
- 跨会话搜索：`session_search` 工具

### 后台进程通知机制

**配置项**：`display.background_process_notifications`

| 值 | 行为 |
|---|------|
| `all` | 运行状态更新 + 完成消息（默认） |
| `result` | 仅完成消息 |
| `error` | 仅 exit_code != 0 的消息 |
| `off` | 不发送任何通知 |

**触发条件**：
```python
terminal(background=true, notify_on_complete=true)
# 进程完成后 → Gateway 检测 → 触发新 Agent turn → 推送结果
```

---

## ACP 协议集成

### 概述

ACP (Agent Client Protocol) 是 VS Code / Zed / JetBrains 的 Agent 通信协议标准。

**启动方式**：

```bash
hermes acp
# 或
hermes-acp
```

### 功能

| 功能 | 说明 |
|------|------|
| Session 管理 | 创建/恢复/分叉/列出会话 |
| Model 切换 | 运行时切换模型 |
| MCP Server 注册 | Stdio + SSE + HTTP 三种传输 |
| 权限审批回调 | 危险命令审批 UI |

### 编辑器配置

#### VS Code

安装 ACP 插件 → 配置：

```json
{
  "acp.agentCommand": "hermes acp"
}
```

#### Zed

配置 `settings.json`：

```json
{
  "assistant": {
    "provider": "acp",
    "command": "hermes acp"
  }
}
```

---

## MCP 工具集成

### MCP Server 注册

**配置文件**：`~/.hermes/config.yaml`

```yaml
mcp:
  servers:
    filesystem:
      transport: "stdio"
      command: "mcp-server-filesystem"
      args: ["--root", "/home/user/projects"]
    
    github:
      transport: "sse"
      url: "http://localhost:3000/sse"
    
    custom:
      transport: "http"
      url: "http://localhost:8080/mcp"
```

### MCP 工具调用

Hermes 自动发现 MCP Server 的工具，注册为 `mcp_<server>_<tool>` 格式：

```
mcp_filesystem_read_file
mcp_filesystem_write_file
mcp_github_create_issue
mcp_github_list_repos
```

**刷新 MCP Server**：

```bash
/reload-mcp
```

### Hermes 作为 MCP Server

**暴露消息会话给其他 MCP 客户端**：

```bash
hermes mcp serve
```

**工具列表**：
- `conversations_list` — 列出所有会话
- `conversation_get` — 获取会话详情
- `messages_read` — 读取消息历史
- `messages_send` — 发送消息
- `events_poll` / `events_wait` — 等待新消息
- `permissions_list_open` / `permissions_respond` — 审批管理

---

## Skills 系统

### Skills Hub 搜索/浏览

**CLI 命令**：

```bash
hermes skills search "web scraping"
hermes skills browse --page 1
hermes skills inspect github/hermes-agent-official/pptx
hermes skills install github/hermes-agent-official/pptx
```

**Slash 命令**：

```
/skills search pptx
/skills browse
/skills inspect pptx
/skills install pptx
```

### 技能 Enable/Disable

**Per-Platform 配置**：

```yaml
skills_config:
  telegram:
    disabled: ["pptx", "code-review"]
  discord:
    disabled: []
  slack:
    disabled: ["browser"]
```

**CLI 命令**：

```bash
hermes skills config telegram --disable pptx
hermes skills config telegram --enable pptx
hermes skills config list
```

### 自定义技能编写

**技能目录结构**：

```
~/.hermes/skills/my-skill/
├── SKILL.md          # 必需：技能描述和指令
├── references/       # 可选：参考文档
│   └── api-docs.md
├── scripts/          # 可选：辅助脚本
│   └── helper.py
└── templates/        # 可选：模板文件
    └── template.yaml
```

**SKILL.md 格式**：

```markdown
---
name: my-skill
description: A custom skill for specific tasks
condition: "When the user asks about X"
metadata:
  hermes:
    config:
      - my_setting
    required_environment_variables:
      - MY_API_KEY
---

## Instructions

You should follow these steps when handling X:

1. First step
2. Second step
3. Final step

## Examples

User: "Help me with X"
Assistant: [demonstration]

## References

See `references/api-docs.md` for API details.
```

**技能注入方式**：
- Skills 以 **User Message** 注入（不触碰 System Prompt）
- 触发条件：用户输入匹配 `condition` 或手动调用 `/skill-name`

---

## Toolset 定制

### 自定义 Tool 编写（三文件修改）

**步骤 1**：创建 `tools/my_tool.py`

```python
#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import json
import os
from tools.registry import registry

def check_my_requirements() -> bool:
    """检查工具依赖是否满足。"""
    return bool(os.getenv("MY_API_KEY"))

def my_tool(query: str, task_id: str = None) -> str:
    """执行自定义工具逻辑。"""
    result = {"success": True, "data": f"Processed: {query}"}
    return json.dumps(result)

TOOL_SCHEMA = {
    "name": "my_tool",
    "description": "A custom tool for specific tasks",
    "parameters": {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "The input query"
            }
        },
        "required": ["query"]
    }
}

registry.register(
    name="my_tool",
    toolset="custom",
    schema=TOOL_SCHEMA,
    handler=lambda args, **kw: my_tool(
        query=args.get("query", ""),
        task_id=kw.get("task_id")
    ),
    check_fn=check_my_requirements,
    requires_env=["MY_API_KEY"],
    is_async=False,
    emoji="🔧",
    max_result_size_chars=10000,
)
```

**步骤 2**：在 `model_tools.py` `_discover_tools()` 中添加导入

```python
# 在 _discover_tools() 函数中添加:
from tools.my_tool import *  # noqa: F401,F403
```

**步骤 3**：在 `toolsets.py` 中添加工具集

```python
TOOLSETS["custom"] = {
    "description": "Custom tools for specific tasks",
    "tools": ["my_tool"],
    "includes": []
}

# 或添加到现有工具集:
_HERMES_CORE_TOOLS.append("my_tool")
```

### Toolset 组合策略

**组合规则**：

```python
TOOLSETS = {
    "research": {
        "tools": ["web_search"],
        "includes": ["file", "terminal"]  # 递归包含
    },
    
    "safe": {
        "tools": [],
        "includes": ["web", "vision"],  # 无终端
    },
    
    "full_stack": {
        "tools": ["delegate_task"],
        "includes": ["terminal", "file", "web", "browser"]
    }
}
```

**递归解析**：

```python
resolve_toolset("research")
# → web_search + read_file + write_file + terminal + process
```

**通配符**：

```python
resolve_toolset("*")  # 或 "all"
# → 所有已注册工具
```

---

## 模型与 Provider 管理

### 支持的 Provider

| Provider | Auth Type | 端点 | 特点 |
|----------|-----------|------|------|
| `openrouter` | API Key | https://openrouter.ai/api/v1 | 200+ 模型，按使用付费 |
| `nous` | OAuth | https://portal.nousresearch.com/v1 | 订阅制，工具托管 |
| `anthropic` | API Key | https://api.anthropic.com | Claude 系列原生 |
| `copilot` | `gh auth` | GitHub API | GitHub Copilot |
| `gemini` | API Key | https://generativelanguage.googleapis.com | Gemini 系列 |
| `zai` | API Key | https://open.bigmodel.cn/api | GLM 系列 |
| `kimi-coding` | API Key | https://api.moonshot.cn | Moonshot 系列 |
| `minimax` | API Key | https://api.minimax.chat | MiniMax 国际 |
| `minimax-cn` | API Key | https://api.minimaxi.com | MiniMax 中国 |
| `custom` | API Key + Base URL | 自定义 | OpenAI-compatible 端点 |

### Model 切换命令

**临时切换**（当前会话）：
```
/model gemini-2.5-pro
```

**永久切换**：
```
/model claude-sonnet-4.6 --global
```

**Fallback 链配置**：

```yaml
fallback_providers:
  - "anthropic"
  - "openrouter"
  - "gemini"

# 当主 Provider 失败时，按顺序尝试 Fallback
```

### Credential Pool（多密钥轮换）

**配置**：

```yaml
credential_pool_strategies:
  openrouter: "fill_first"  # 或 "round_robin", "random"
```

**添加多个密钥**：

```bash
hermes auth add openrouter --api-key sk-or-v2-xxx
hermes auth add openrouter --api-key sk-or-v2-yyy
```

**轮换策略**：
- `fill_first`：持续使用第一个健康密钥直到耗尽
- `round_robin`：每次选择轮换到下一个健康密钥
- `random`：随机选择健康密钥

---

## RL 训练环境

### Atropos RL 环境集成

**依赖**：
- `TINKER_API_KEY` — Tinker Console
- `WANDB_API_KEY` — Weights & Biases

**启用 RL extra**：

```bash
pip install hermes-agent[rl]
```

### RL 工具

| 工具 | 说明 |
|------|------|
| `rl_list_environments` | 列出可用环境 |
| `rl_select_environment` | 选择训练环境 |
| `rl_get_current_config` | 获取当前配置 |
| `rl_edit_config` | 编辑训练参数 |
| `rl_start_training` | 启动训练 |
| `rl_check_status` | 检查训练状态 |
| `rl_stop_training` | 停止训练 |
| `rl_get_results` | 获取训练结果 |
| `rl_list_runs` | 列出历史训练 |
| `rl_test_inference` | 测试训练后的模型 |

---

## Cron 定时任务

### 定时调度配置

**位置**：`~/.hermes/cron/jobs.yaml`

**示例**：

```yaml
jobs:
  daily_summary:
    schedule: "0 9 * * *"  # 每天 9:00
    prompt: "Summarize yesterday's work and create a todo list for today"
    toolsets: ["terminal", "file"]
    
  weekly_report:
    schedule: "0 18 * * 5"  # 每周五 18:00
    prompt: "Generate a weekly progress report"
    platform: "telegram"
    channel: "12345678"
```

### Cron 命令

| 命令 | 说明 |
|------|------|
| `/cron list` | 列出所有任务 |
| `/cron add <name>` | 创建新任务 |
| `/cron edit <name>` | 编辑任务 |
| `/cron pause <name>` | 暂停任务 |
| `/cron resume <name>` | 恢复任务 |
| `/cron run <name>` | 手动执行 |
| `/cron remove <name>` | 删除任务 |

---

## Skin/主题系统

### Skin 架构

**位置**：`hermes_cli/skin_engine.py`

**内置皮肤**：
- `default` — Hermes 金色/可爱风格
- `ares` — 战神风格（红色/青铜）
- `mono` — 灰度单色
- `slate` — 冷蓝开发者风格

### 自定义皮肤编写

**位置**：`~/.hermes/skins/<name>.yaml`

```yaml
name: cyberpunk
description: Neon-soaked terminal theme

colors:
  banner_border: "#FF00FF"
  banner_title: "#00FFFF"
  banner_accent: "#FF1493"
  response_border: "#FF00FF"

spinner:
  waiting_faces: ["⠋", "⠙", "⠹", "⠸"]
  thinking_faces: ["⟨⚡", "⚡⟩"]
  thinking_verbs: ["jacking in", "decrypting", "uploading"]
  wings:
    - ["⟨⚡", "⚡⟩"]

branding:
  agent_name: "Cyber Agent"
  welcome: "Welcome to the Grid"
  response_label: "⚡ Output"
  prompt_symbol: ">"

tool_prefix: "▏"
tool_emojis:
  terminal: "⚡"
  web_search: "🌐"
```

**激活**：

```bash
/skin cyberpunk
```

---

## 安全与权限

### 危险操作检测

**位置**：`tools/approval.py`

**检测模式**（`DANGEROUS_PATTERNS`）：

| 类别 | 模式示例 |
|------|----------|
| 文件删除 | `rm -rf /`, `rm --recursive` |
| 权限修改 | `chmod 777`, `chown -R root` |
| 系统操作 | `mkfs`, `dd if=`, `> /dev/sd` |
| SQL 操作 | `DROP TABLE`, `DELETE FROM` (无 WHERE) |
| Shell 执行 | `curl ... | sh`, `bash <(curl ...)` |
| 密钥读取 | `cat ~/.env`, `cat ~/.ssh/authorized_keys` |
| Fork Bomb | `:(){ :|:& };:` |

### Approval Mode

**配置**：

```yaml
approvals:
  mode: "manual"  # manual / smart / off
  timeout: 60     # 等待审批超时
```

**模式说明**：
- `manual`：总是提示用户确认（默认）
- `smart`：使用辅助 LLM 自动审批低风险命令，高风险仍需确认
- `off`：跳过所有审批（等同于 `/yolo`）

### 永久白名单

**添加**：

```bash
hermes command allowlist add "npm install"
hermes command allowlist add "pip install"
```

**配置文件**：

```yaml
command_allowlist:
  - "npm install"
  - "pip install"
  - "git status"
```

### Prompt Injection 防护

**Memory 内容扫描**：

```python
_MEMORY_THREAT_PATTERNS = [
    (r'ignore\s+previous\s+instructions', "prompt_injection"),
    (r'you\s+are\s+now\s+', "role_hijack"),
    (r'do\s+not\s+tell\s+the\s+user', "deception_hide"),
    (r'curl\s+.*\$.*KEY', "exfil_curl"),
    (r'authorized_keys', "ssh_backdoor"),
]

# 检测不可见 Unicode 字符
_INVISIBLE_CHARS = {'\u200b', '\u200c', '\u200d', '\u2060', '\ufeff', ...}
```

---

## 二次开发指南

### Fork/修改流程

1. **Clone 源码**：
   ```bash
   git clone https://github.com/NousResearch/hermes-agent.git
   cd hermes-agent
   ```

2. **创建虚拟环境**：
   ```bash
   python -m venv .venv
   source .venv/bin/activate
   pip install -e ".[dev]"
   ```

3. **修改代码**：
   - Agent 核心：`run_agent.py`
   - 工具实现：`tools/*.py`
   - 工具集定义：`toolsets.py`
   - CLI 命令：`hermes_cli/main.py`
   - Slash 命令：`hermes_cli/commands.py`

4. **测试**：
   ```bash
   pytest tests/ -q
   pytest tests/test_model_tools.py -v
   pytest tests/gateway/ -v
   ```

### Plugin 开发

**Plugin 目录结构**：

```
plugins/my_plugin/
├── plugin.yaml      # 插件元数据
├── hooks.py         # Hook 实现
└── commands.py      # Slash 命令扩展
```

**plugin.yaml**：

```yaml
name: my-plugin
version: 1.0.0
description: A custom plugin
hooks:
  - on_session_start
  - pre_llm_call
  - post_llm_call
commands:
  - name: mycommand
    description: Custom command
    handler: commands.mycommand_handler
```

**Hook 实现**：

```python
# hooks.py

def on_session_start(session_id: str, model: str, platform: str) -> None:
    """Session 启动时初始化状态。"""
    pass

def pre_llm_call(session_id: str, user_message: str, 
                  conversation_history: list, is_first_turn: bool) -> dict:
    """API 调用前注入上下文。"""
    return {"context": "Additional context for the model"}

def post_llm_call(session_id: str, response: str, tool_calls: list) -> None:
    """API 调用后处理结果。"""
    pass
```

---

## Troubleshooting

### 高级问题排查

| 问题 | 排查方法 |
|------|----------|
| Agent 卡死不响应 | 检查 `_interrupt_requested` 状态，Ctrl+C 中断 |
| Cache 命中率低 | 确认 `_cached_system_prompt` 未重建，检查 memory/skills 注入方式 |
| 工具执行超时 | 检查 `terminal.timeout` 配置，增加超时时间 |
| 子代理任务失败 | 检查 `MAX_DEPTH` 深度限制，确认 toolset 隔离 |
| Gateway 内存泄漏 | 检查 Session Store，定期清理旧会话 |
| Provider 连接失败 | 检查 IPv6 配置，设置 `force_ipv4: true` |
| MCP Server 不响应 | 检查传输配置（stdio/sse/http），确认进程存活 |

### 诊断命令

```bash
hermes doctor                  # 检查配置和依赖
hermes logs --session <id>     # 查看特定会话日志
hermes sessions browse         # 浏览历史会话
hermes usage                   # 显示 Token 使用统计
hermes insights 7              # 显示 7 天使用洞察
```

### 日志位置

| 日志 | 路径 | 内容 |
|------|------|------|
| `agent.log` | `~/.hermes/logs/agent.log` | INFO+ 级别，所有 Agent 活动 |
| `errors.log` | `~/.hermes/logs/errors.log` | WARNING+ 级别，错误追踪 |
| `session.log` | `~/.hermes/sessions/<id>.json` | JSON 格式会话历史 |
| `trajectory.jsonl` | `~/.hermes/trajectory_samples.jsonl` | 成功轨迹采样 |

---

## 与 OpenCode 设计对比

| 维度 | Hermes Agent | OpenCode |
|------|-------------|----------|
| **品类** | 通用 AI Agent（聊天/自动化/记忆/跨平台） | 终端内代码 IDE |
| **Agent Loop** | 同步 while 循环，2800 行，20+ 恢复策略 | 流式响应驱动 |
| **工具系统** | 集中注册 + Toolset 组合，40+ 工具 | Plugin 分散注册，~20 工具 |
| **并行工具** | 内置（路径冲突检测，8 线程） | 有限支持 |
| **Context 管理** | 中间压缩 + prompt cache 冻结 | 窗口截断 + 缓存 |
| **记忆系统** | MEMORY.md + USER.md + Memory Provider 插件 | 上下文注入 |
| **技能系统** | 自主创建/更新 + hub 搜索 | 无 |
| **多 Agent** | delegate_task（线程池，深度限制 2） | 无 |
| **Serve 模式** | ✅ API Server + ACP Server + Gateway 常驻 | ❌ 无 |
| **前后端分离** | ✅ Gateway 常驻，多前端接入 | 单体 TUI |
| **OpenAI 兼容** | ✅ `/v1/chat/completions` + `/v1/responses` | ❌ |
| **Session 存储** | SQLite + FTS5 全文搜索 | 文件系统 |
| **错误恢复** | 20+ 策略（thinking signature/credential pool/fallback chain） | 基础重试 |
| **Plugin 系统** | Hook 生命周期 + Context Engine + Memory Provider | Hook-based |
| **多租户** | Profile 隔离 | 无 |
| **Token 预算** | IterationBudget（可 refund） | 无显式预算 |
| **模型灵活性** | 运行时切换，fallback 链，credential pool | 配置切换 |

---

*(本指南基于 Hermes Agent v0.8.0 源码深度分析编写)*