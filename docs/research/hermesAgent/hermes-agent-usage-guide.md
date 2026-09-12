# Hermes Agent 基础使用指南

> **版本**: v0.8.0  
> **项目**: Nous Research — Hermes Agent (MIT License)  
> **研究日期**: 2026-04-17

---

## 概述

Hermes Agent 是一个 **自我进化的 AI Agent**——能够自主学习、持久记忆、跨平台运行的通用智能助手。

**核心特性**：
- **多模型支持**：OpenRouter（200+ 模型）、Anthropic、OpenAI、Gemini、Copilot、Ollama、MiniMax、Kimi、Qwen、Mistral 等
- **40+ 工具**：Web 搜索、浏览器自动化、终端执行、文件操作、视觉分析、图像生成、TTS、记忆、技能等
- **跨平台部署**：CLI TUI、Telegram、Discord、Slack、WhatsApp、Signal、Matrix、Email 等 15+ 消息平台
- **自我学习**：自动记忆沉淀、自主技能创建、后台审查 Agent

**适用场景**：
- 个人 AI 助手（聊天、研究、编程）
- 自动化工作流（定时任务、消息监控）
- 多平台机器人服务（Telegram/Discord/Slack 等）
- VS Code / Zed / JetBrains 编辑器集成

---

## 安装

### 系统要求

- **Python**: 3.11+
- **操作系统**: macOS / Linux / Windows（终端执行功能在 macOS/Linux 上最佳）
- **推荐**: 已有虚拟环境（如 `.venv`）

### 安装方式

```bash
# 方式一：pip 安装
pip install hermes-agent

# 方式二：从源码安装
git clone https://github.com/NousResearch/hermes-agent.git
cd hermes-agent
pip install -e .
```

**可选扩展**（当前不可用）：
- `[voice]` — 语音输入/输出（需要额外依赖）
- `[matrix]` — Matrix 消息平台（需要额外依赖）

### 验证安装

```bash
hermes version
# 输出: hermes-agent v0.8.0
```

---

## 首次配置

### 配置向导

```bash
hermes setup
```

向导将引导你完成：
1. **模型 & Provider** — 选择 AI 服务提供商和模型
2. **终端后端** — 选择命令执行环境（local / Docker / SSH / Modal）
3. **Agent 设置** — 迭代次数、上下文压缩、会话重置
4. **消息平台** — 配置 Telegram / Discord / Slack 等（可选）
5. **工具设置** — 配置 TTS、Web 搜索、图像生成等（可选）

### 手动配置

#### config.yaml 配置文件

位置：`~/.hermes/config.yaml`

**完整配置示例**：

```yaml
# 模型配置
model:
  default: "anthropic/claude-opus-4.6"
  provider: "openrouter"  # 或 "nous", "anthropic", "custom"

# 工具集
toolsets:
  - "hermes-cli"

# Agent 设置
agent:
  max_turns: 90  # 最大工具调用轮次
  gateway_timeout: 1800  # Gateway 空闲超时（秒）
  reasoning_effort: ""  # 推理强度: none/minimal/low/medium/high/xhigh

# 终端后端
terminal:
  backend: "local"  # local / docker / ssh / modal / daytona
  cwd: "."  # 工作目录
  timeout: 180  # 命令超时（秒）
  docker_image: "nikolaik/python-nodejs:python3.11-nodejs20"

# 上下文压缩
compression:
  enabled: true
  threshold: 0.50  # 触发阈值（上下文使用率）
  summary_model: ""  # 空则使用主模型

# TTS 配置
tts:
  provider: "edge"  # edge（免费）/ elevenlabs / openai / minimax / mistral / neutts
  edge:
    voice: "en-US-AriaNeural"

# 显示设置
display:
  compact: false
  personality: "kawaii"
  streaming: true
  skin: "default"

# 记忆设置
memory:
  memory_enabled: true
  user_profile_enabled: true
  memory_char_limit: 2200

# 安全设置
security:
  redact_secrets: true
  tirith_enabled: true
```

#### .env 环境变量

位置：`~/.hermes/.env`

**必需变量**（根据所选 Provider）：

| Provider | 变量 | 获取地址 |
|----------|------|----------|
| OpenRouter | `OPENROUTER_API_KEY` | https://openrouter.ai/keys |
| Anthropic | `ANTHROPIC_API_KEY` | https://console.anthropic.com |
| OpenAI | `OPENAI_API_KEY` | https://platform.openai.com/api-keys |
| Gemini | `GOOGLE_API_KEY` 或 `GEMINI_API_KEY` | https://aistudio.google.com/app/apikey |
| Nous Portal | OAuth 登录（无需手动设置） | https://portal.nousresearch.com |

**可选工具变量**：

| 工具 | 变量 | 用途 |
|------|------|------|
| Web 搜索 | `EXA_API_KEY` / `FIRECRAWL_API_KEY` / `TAVILY_API_KEY` | AI 原生搜索 |
| 浏览器 | `BROWSERBASE_API_KEY` / `CAMOFOX_URL` | 云端/本地浏览器 |
| 图像生成 | `FAL_KEY` | FAL.ai 图像生成 |
| TTS | `ELEVENLABS_API_KEY` | ElevenLabs 高质量语音 |
| RL 训练 | `TINKER_API_KEY` + `WANDB_API_KEY` | 强化学习 |
| Skills Hub | `GITHUB_TOKEN` | 技能搜索/发布 |

---

## 运行模式

### 单次对话

```bash
hermes-agent "解释什么是量子纠缠"
```

适用于一次性查询，无需进入交互模式。

### 交互式 CLI

```bash
hermes
# 或
hermes chat
# 或
hermes-agent --interactive
```

启动交互式终端界面（Rich TUI），支持：
- Slash 命令（见下一节）
- 文件拖放/粘贴图片
- 多轮对话持久化

### Profile 模式

Profile 是完全隔离的多实例配置，每个 Profile 有独立的：
- 配置文件（`~/.hermes/profiles/<name>/config.yaml`）
- 环境变量（`~/.hermes/profiles/<name>/.env`）
- 记忆文件（`~/.hermes/profiles/<name>/memories/`）
- 会话存储（`~/.hermes/profiles/<name>/sessions/`）

```bash
# 使用指定 profile
hermes -p wopalspace

# 或
hermes --profile=coder
```

**Profile 管理命令**：

```bash
hermes profile use <name>    # 设置默认 profile（sticky）
hermes profile show          # 显示当前 profile 详情
hermes profile list          # 列出所有 profile
hermes profile create <name> # 创建新 profile
hermes profile delete <name> # 删除 profile
hermes profile alias <name> [alias] # 设置 profile 别名
hermes profile rename <old> <new>   # 重命名 profile
hermes profile export <name>        # 导出 profile 为 zip
hermes profile import <file>        # 从 zip 导入 profile
```

---

## Profile 管理

### Profile 结构

```
~/.hermes/
├── config.yaml           # 默认配置
├── .env                  # 默认环境变量
├── memories/
│   ├── MEMORY.md
│   └── USER.md
├── sessions/             # 会话数据库
├── skills/               # 技能目录
├── profiles/
│   ├── coder/
│   │   ├── config.yaml
│   │   ├── .env
│   │   ├── memories/
│   │   └── sessions/
│   └── wopalspace/
│       └── ...
└── active_profile        # 当前激活的 profile 名称
```

### Profile 操作

| 操作 | 命令 |
|------|------|
| 创建 | `hermes profile create <name>` |
| 切换 | `hermes -p <name>` 或 `hermes profile use <name>` |
| 列出 | `hermes profile list` |
| 当前详情 | `hermes profile show` |
| 删除 | `hermes profile delete <name>` |
| 别名 | `hermes profile alias <name> [alias]` |
| 重命名 | `hermes profile rename <old> <new>` |
| 导出 | `hermes profile export <name>` |
| 导入 | `hermes profile import <file>` |

### 配置隔离

每个 Profile 的配置完全独立：
- 不同模型（例如 coder 用 Claude，researcher 用 Gemini）
- 不同工具集（例如禁用 coder 的 Web 搜索）
- 不同 API 密钥（例如多个 OpenRouter 账户轮换）
- 不同记忆内容（每个 Profile 有自己的 MEMORY.md）

---

## 常用命令

### Session 管理

| 命令 | 别名 | 说明 |
|------|------|------|
| `/new` | `/reset` | 开始新会话 |
| `/clear` | — | 清屏并开始新会话 |
| `/history` | — | 显示对话历史 |
| `/save` | — | 保存当前会话 |
| `/retry` | — | 重发最后一条消息 |
| `/undo` | — | 删除最后一轮对话 |
| `/title [name]` | — | 设置会话标题 |
| `/branch [name]` | `/fork` | 分支当前会话 |
| `/compress [topic]` | — | 手动压缩上下文 |
| `/rollback [num]` | — | 恢复文件系统快照 |
| `/stop` | — | 终止所有后台进程 |
| `/background <prompt>` | `/bg` | 后台运行任务 |
| `/btw <question>` | — | 不使用工具的临时提问 |
| `/queue <prompt>` | `/q` | 排队下一个任务 |
| `/status` | — | 显示会话状态 |
| `/resume [name]` | — | 恢复之前的会话 |

### 配置管理

| 命令 | 说明 |
|------|------|
| `/config` | 显示当前配置 |
| `/model [model] [--global]` | 切换模型 |
| `/provider` | 显示可用 Provider |
| `/personality [name]` | 设置人格（helpful/concise/technical/kawaii 等） |
| `/statusbar` | `/sb` 切换状态栏 |
| `/verbose` | 切换工具进度显示 |
| `/yolo` | 切换 YOLO 模式（跳过危险命令审批） |
| `/reasoning [level|show|hide]` | 管理推理强度和显示 |
| `/fast [normal|fast|status]` | 切换快速模式 |
| `/skin [name]` | 切换显示主题 |
| `/voice [on|off|tts|status]` | 切换语音模式 |

### 工具与技能

| 命令 | 说明 |
|------|------|
| `/tools [list|disable|enable] [name...]` | 管理工具 |
| `/toolsets` | 列出可用工具集 |
| `/skills [search|browse|inspect|install]` | Skills Hub 操作 |
| `/cron [list|add|edit|pause|resume|run|remove]` | 定时任务管理 |
| `/reload-mcp` | 重载 MCP Server |
| `/browser [connect|disconnect|status]` | 连接本地 Chrome CDP |
| `/plugins` | 列出已安装插件 |

### 信息查询

| 命令 | 说明 |
|------|------|
| `/help` | 显示帮助 |
| `/usage` | 显示 Token 使用和速率限制 |
| `/insights [days]` | 显示使用洞察 |
| `/platforms` | `/gateway` 显示消息平台状态 |
| `/paste` | 从剪贴板粘贴图片 |
| `/image <path>` | 附加本地图片 |

### 退出

| 命令 | 别名 | 说明 |
|------|------|------|
| `/quit` | `/exit`, `/q` | 退出 CLI |

---

## 工具使用

### 核心 26 工具

| 类别 | 工具 | 说明 |
|------|------|------|
| **Web** | `web_search` | AI 原生 Web 搜索（Exa / Firecrawl / Tavily） |
| | `web_extract` | 抓取网页内容并总结 |
| **终端** | `terminal` | 执行 Shell 命令（支持后台运行） |
| | `process` | 管理后台进程 |
| **文件** | `read_file` | 读取文件内容 |
| | `write_file` | 写入文件 |
| | `patch` | 模糊匹配编辑 |
| | `search_files` | 搜索文件内容 |
| **视觉** | `vision_analyze` | 分析图片（多模型支持） |
| **图像生成** | `image_generate` | 生成图片（FAL.ai） |
| **技能** | `skills_list` | 列出可用技能 |
| | `skill_view` | 查看技能内容 |
| | `skill_manage` | 创建/编辑/安装技能 |
| **浏览器** | `browser_navigate` | 打开网页 |
| | `browser_snapshot` | 截图 |
| | `browser_click` | 点击元素 |
| | `browser_type` | 输入文字 |
| | `browser_scroll` | 滚动页面 |
| | `browser_back` | 返回上一页 |
| | `browser_press` | 按键 |
| | `browser_get_images` | 获取页面图片 |
| | `browser_vision` | 视觉分析页面区域 |
| | `browser_console` | 执行 JavaScript |
| **TTS** | `text_to_speech` | 文字转语音（Edge/ElevenLabs/OpenAI/MiniMax/Mistral） |
| **规划** | `todo` | 任务规划与跟踪 |
| **记忆** | `memory` | 持久化记忆（add/replace/remove/read） |
| **搜索** | `session_search` | 搜索历史会话 |
| **交互** | `clarify` | 向用户提问确认 |
| **编程** | `execute_code` | 执行 Python 代码（调用工具） |
| **委托** | `delegate_task` | 委派子任务给子 Agent |
| **定时** | `cronjob` | 管理定时任务 |
| **消息** | `send_message` | 跨平台发送消息 |
| **智能家居** | `ha_list_entities` | 列出 Home Assistant 设备 |
| | `ha_get_state` | 获取设备状态 |
| | `ha_list_services` | 列出可用服务 |
| | `ha_call_service` | 调用智能家居服务 |

### 不可用工具说明

以下工具需要额外配置或依赖：

| 工具 | 要求 | 解决方案 |
|------|------|----------|
| `vision_analyze` | Vision 后端 API Key | 配置 `OPENROUTER_API_KEY` 或 `OPENAI_API_KEY` |
| `image_generate` | `FAL_KEY` | 获取 FAL.ai API Key |
| `mixture_of_agents` | `OPENROUTER_API_KEY` | 多模型并行推理 |
| `web_search` / `web_extract` | `EXA_API_KEY` / `FIRECRAWL_API_KEY` / `TAVILY_API_KEY` | 任选其一 |
| `browser_*` | 本地 Chrome 或 `BROWSERBASE_API_KEY` | 运行 `npm install -g agent-browser` |
| `rl_*` | `TINKER_API_KEY` + `WANDB_API_KEY` | RL 训练工具 |
| `ha_*` | `HASS_TOKEN` | Home Assistant 集成 |

---

## 配置详解

### model 配置

```yaml
model:
  default: "anthropic/claude-opus-4.6"  # 默认模型
  provider: "openrouter"                # Provider: openrouter/nous/anthropic/custom
  base_url: ""                          # 自定义端点 URL
```

**Provider 列表**：

| Provider | 说明 |
|----------|------|
| `openrouter` | OpenRouter（200+ 模型，按使用付费） |
| `nous` | Nous Portal（订阅制） |
| `anthropic` | Anthropic API（Claude） |
| `copilot` | GitHub Copilot |
| `gemini` | Google AI Studio |
| `zai` | Z.AI / GLM |
| `kimi-coding` | Kimi / Moonshot |
| `minimax` | MiniMax |
| `custom` | 自定义 OpenAI-compatible 端点 |

### terminal 配置

```yaml
terminal:
  backend: "local"       # local/docker/ssh/modal/daytona/singularity
  cwd: "."               # 工作目录
  timeout: 180           # 命令超时（秒）
  docker_image: "nikolaik/python-nodejs:python3.11-nodejs20"
  container_cpu: 1       # CPU 核数
  container_memory: 5120 # 内存 MB
  container_disk: 51200  # 磁盘 MB
```

### compression 配置

```yaml
compression:
  enabled: true
  threshold: 0.50        # 触发阈值（上下文使用率）
  target_ratio: 0.20     # 目标保留比例
  protect_last_n: 20     # 保护最近 N 条消息
  summary_model: ""      # 空则使用主模型
```

### tts 配置

```yaml
tts:
  provider: "edge"       # edge/elevenlabs/openai/minimax/mistral/neutts
  edge:
    voice: "en-US-AriaNeural"
  elevenlabs:
    voice_id: "pNInz6obpgDQGcFmaJgB"
```

### display 配置

```yaml
display:
  compact: false
  personality: "kawaii"  # helpful/concise/technical/creative/kawaii/catgirl 等
  streaming: true
  show_reasoning: false
  skin: "default"        # default/ares/mono/slate
```

---

## 常见问题

### API Key 问题

**问题**：启动时报错 "no API keys or providers found"

**解决方案**：
1. 运行 `hermes setup` 选择 Provider
2. 或手动在 `~/.hermes/.env` 中设置 API Key：
   ```
   OPENROUTER_API_KEY=sk-or-...
   ```

### 模型切换

**临时切换**（仅当前会话）：
```
/model gemini-2.5-pro
```

**永久切换**：
```
/model claude-sonnet-4.6 --global
```

### 工具不可用

**问题**：某些工具返回 "not available"

**排查**：
1. 检查 `hermes tools list` 确认工具状态
2. 检查 `~/.hermes/.env` 是否有必需的 API Key
3. 运行 `hermes setup tools` 配置工具

### 上下文过长

**现象**：对话过长后响应变慢或报错

**解决方案**：
- 自动压缩已启用（默认 threshold=0.50）
- 手动压缩：`/compress`
- 减少保护消息数：修改 `compression.protect_last_n`

### 危险命令审批

**现象**：执行 `rm` 等命令需要确认

**解决方案**：
- YOLO 模式：`/yolo` 跳过所有审批
- 智能审批：设置 `approvals.mode: smart`
- 添加白名单：`/approve always`

---

## 快速参考

### 常用命令速查

```
hermes setup              # 首次配置
hermes                    # 启动交互 CLI（等同于 hermes chat）
hermes -p <profile>       # 使用指定 profile
hermes gateway            # 启动消息 Gateway
hermes acp                # 启动 ACP Server（编辑器集成）
hermes doctor             # 检查配置和依赖
hermes sessions list      # 列出历史会话
hermes tools list         # 列出可用工具
hermes model              # 切换模型
hermes skills             # 技能管理
hermes cron list          # 查看定时任务
hermes auth               # 查看认证状态
hermes plugins list       # 查看已安装插件
hermes memory             # 配置外部 memory provider
hermes backup             # 备份整个 heredmes home
hermes update             # 更新到最新版本
hermes uninstall          # 卸载 Hermes
```

### 配置文件位置

| 文件 | 路径 | 用途 |
|------|------|------|
| `config.yaml` | `~/.hermes/config.yaml` | 主配置 |
| `.env` | `~/.hermes/.env` | API Keys |
| `MEMORY.md` | `~/.hermes/memories/MEMORY.md` | Agent 记忆 |
| `USER.md` | `~/.hermes/memories/USER.md` | 用户画像 |
| `SOUL.md` | `~/.hermes/SOUL.md` | Agent 人格 |
| `sessions/` | `~/.hermes/sessions/` | 会话数据库 |
| `skills/` | `~/.hermes/skills/` | 技能目录 |

---

*(本指南基于 Hermes Agent v0.8.0 源码分析编写)*