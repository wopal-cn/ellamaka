# Ellamaka 配置机制
> **日期**: 2026-04-26
> **文档目标**: 理解 Ellamaka 配置加载链路、provider auth 配置方式、环境变量覆盖机制

---

## 一、配置加载链路

### 运行模式

ellamaka 有两种运行模式，配置加载链路完全不同：

| 模式 | 激活方式 | 行为 |
|------|---------|------|
| 普通模式（opencode 兼容） | 默认（非 wopal-space 目录） | 加载 opencode 兼容层 + ellamaka 全局配置 |
| wopal-space 模式 | 自动检测（`.wopal/.git` 文件） | 短路到 wopal-space 配置体系 |

#### wopal-space 自动检测

从 cwd 向上查找 `.wopal/.git` 为文件的最近祖先目录（ontology worktree 标记），以此作为空间根。检测在用户 home 目录处停止。用户可显式传入 `--disable-wopalspace` 强制禁用自动检测（逃生舱），恢复原生 opencode 行为。

> CLI flag 使用 `--disable-wopalspace`（无 `no-` 前缀）而非 `--no-wopal-space`：yargs 对 `--no-XXX` 有内置取反解析，会把 `--no-wopal-space` 解析为未声明的 `wopalSpace` 字段，触发 `.strict()` 报错并打印 help。

实现位于 `packages/ellamaka/detect.ts` 的 `detectWopalSpace(cwd)` 函数，返回 `{ root, wopalDir }` 或 undefined。在 `packages/opencode/src/index.ts` 的 yargs 中间件中调用，检测到则设置 `WOPAL_SPACE=1` 和 `WOPAL_SPACE_ROOT=<空间根>`。

### 普通模式链路

配置通过 `packages/opencode/src/config/config.ts` 中的 `init()` 加载，多层合并。

| 优先级 | 来源 | 说明 |
|--------|------|------|
| 1 | `OPENCODE_CONFIG_CONTENT` | 环境变量直接传入 JSON 字符串，`local` 级别 |
| 2 | `OPENCODE_CONFIG` | 环境变量指定配置文件路径，`local` 级别 |
| 3 | `OPENCODE_CONFIG_DIR` | 环境变量指定配置目录，扫描其下 `opencode.json` / `opencode.jsonc` |
| 4 | `.opencode/` 目录 | 从 cwd 向上逐级查找 `.opencode/`，加载其中的 `opencode.json` / `opencode.jsonc` |
| 5 | 项目级 `opencode.json` / `opencode.jsonc` | 从 cwd 向上找至 worktree 边界 |
| 6 | 全局配置 | `~/.wopal/config/settings.jsonc`（`ellamaka` 字段，通过 `WOPAL_HOME` 定制） |
| 7 | opencode XDG 全局配置 | `~/.config/opencode/config.json` / `opencode.json[c]`（兼容层底配置） |
| 8 | 远程 `.well-known/opencode` | 若设 `OPENCODE_AUTO_SHARE`，从共享 URL 拉取 |

**能力加载顺序**（后加载覆盖先加载）：

| 优先级 | 来源 | 说明 |
|--------|------|------|
| 1 | `.opencode/`、`~/.opencode/`、`~/.config/opencode/` | opencode 生态能力（原生路径，优先扫描） |
| 2 | `~/.wopal/`（`WOPAL_HOME`） | ellamaka 全局能力（agents/commands/plugins/skills），最后加载覆盖同名能力 |

> `~/.wopal/config/` 是纯配置目录，不参与能力扫描；能力只来自 `~/.wopal/` 根下的 capability 子目录。

**插件依赖安装（ellamaka 增强）**：能力扫描到 `~/.wopal/` 时，额外为该目录下的本地插件安装其 `package.json` 声明的依赖。

- **upstream 行为**：opencode 对每个能力目录只调 `npmSvc.install(dir, { add: [{ name: "@opencode-ai/plugin" }] })`，仅装 plugin SDK 公共头文件。对 `file://` 本地插件，`resolvePluginTarget`（`plugin/shared.ts`）只解析路径、检查 `package.json` 存在，**不安装插件自身的 `dependencies`**。upstream 假设 `file://` 插件由开发者自行管理依赖。
- **ellamaka 增强**：扫描到 `~/.wopal/`（`Global.Path.wopalHome`）时，复用 wopal-space 模式的 `localPluginInstallDeps(dir)` 收集该目录下所有本地插件的 `file:` 依赖，与 `@opencode-ai/plugin` 一起交给 `npmSvc.install` 安装。
- **范围**：仅对 `~/.wopal/` 触发；其他能力目录（`.opencode/`、`~/.opencode/`、`~/.config/opencode/`）走 upstream 默认路径，只装 `@opencode-ai/plugin`。
- 实现位于 `packages/opencode/src/config/config.ts` 的目录循环，函数定义在 `packages/opencode/src/config/wopal-space.ts`。

**合并规则**：高优先级配置通过 `mergeDeep` 覆盖低优先级的同名键，`agent`、`mode`、`plugin`、`command` 等特殊键做深度合并。

**禁用项目配置**：`OPENCODE_DISABLE_PROJECT_CONFIG=true` 跳过第 4、5 步。

### wopal-space 模式链路

自动检测到空间根后，直接短路到 wopal-space 配置体系，不碰任何 opencode 路径。空间根由 `WOPAL_SPACE_ROOT` 定位。

| 优先级 | 来源 | 说明 |
|--------|------|------|
| 1 | `OPENCODE_CONFIG_CONTENT` | 同普通模式 |
| 2 | `~/.wopal/config/settings.jsonc` | 全局配置（`ellamaka` 字段） |
| 3 | `~/.wopal/` | 全局能力扫描（agents/commands/plugins/skills） |
| 4 | `<WOPAL_SPACE_ROOT>/.wopal/config/settings.json[c]` | 空间配置（`ellamaka` + `tui` 字段） |
| 5 | `<WOPAL_SPACE_ROOT>/.wopal/` | 空间能力扫描（agents/commands/plugins/skills） |
| 6 | `<WOPAL_SPACE_ROOT>/.wopal/agents/{name}.md` | agent frontmatter（permission 最高优先级） |

> `~/.wopal/config/` 是纯配置目录，不扫描能力。能力来自 `~/.wopal/`（全局）和 `.wopal/`（空间）。
>
> **环境变量 (`.env`) 装载边界**：Core `Global` 模块不装载 `.env` 文件，`process.env` 只表达真实进程启动环境与 shell 临时覆盖。`$WOPAL_HOME/.env` 与 `<wopalSpaceRoot>/.wopal/.env` 由 wopal-plugin 的 per-invocation effective env loader 消费（`PluginInput.wopalSpaceRoot` 定位空间根），优先级为真实 process/shell env > 当前空间 `.env` > 全局 `.env`。

wopal-space 模式**不加载**：
- 项目级 `opencode.jsonc` / `.opencode/`
- `~/.config/opencode/` 下的 opencode 全局配置
- `~/.opencode/` 下的 opencode 全局能力

---

## 二、核心环境变量

定义于 `packages/ellamaka-core/src/flag/flag.ts`。

### 配置相关

| 变量 | 类型 | 说明 |
|------|------|------|
| `OPENCODE_CONFIG` | string | 指定 `opencode.json` **文件路径** |
| `OPENCODE_CONFIG_CONTENT` | string | 直接传入配置 **JSON 内容** |
| `OPENCODE_CONFIG_DIR` | string | 指定配置 **目录**（替代 `.opencode/` 行为） |
| `OPENCODE_TUI_CONFIG` | string | 指定 TUI 配置文件路径 |
| `OPENCODE_DISABLE_PROJECT_CONFIG` | boolean | 禁用所有项目级配置（cwd 向上扫描） |

### 认证相关

| 变量 | 说明 |
|------|------|
| `OPENCODE_SERVER_PASSWORD` | 远程 server 的 basic auth 密码 |
| `OPENCODE_SERVER_USERNAME` | 远程 server 的 basic auth 用户名，默认 `opencode` |
| `OPENCODE_PERMISSION` | 权限默认策略（传给非 TUI 场景） |

### Provider 特有环境变量

各 provider 在 `src/provider/provider.ts` 中定义 `env` 字段，声明其依赖的环境变量（如 `OPENAI_API_KEY`、`ANTHROPIC_API_KEY` 等）。加载时按数组顺序取首个有值的变量。

### 其他关键变量

| 变量 | 说明 |
|------|------|
| `WOPAL_SPACE` | 激活 wopal-space 模式（自动检测设置） |
| `WOPAL_SPACE_ROOT` | 检测到的空间根绝对路径（内部状态，不接受用户环境变量注入） |
| `WOPAL_HOME` | 覆盖 `~/.wopal/` 根路径 |
| `OPENCODE_MODELS_URL` | 自定义模型发现 URL |
| `OPENCODE_MODELS_PATH` | 自定义模型发现文件路径 |
| `OPENCODE_DB` | 指定数据库路径 |
| `OPENCODE_SKIP_MIGRATIONS` | 跳过数据库迁移 |

---

## 三、`opencode.json` 配置结构

### Provider 配置

```json
{
  "provider": {
    "<provider-id>": {
      "api": "https://custom-endpoint.com/v1",
      "name": "显示名称",
      "env": ["CUSTOM_API_KEY"],
      "options": {
        "apiKey": "sk-xxx",
        "baseURL": "https://custom-endpoint.com/v1",
        "enterpriseUrl": "https://github-enterprise.example.com",
        "timeout": 300000,
        "chunkTimeout": 60000
      },
      "models": {
        "<model-id>": {
          "id": "actual-model-id",
          "name": "Model Display Name",
          "tool_call": true,
          "reasoning": true,
          "limit": {
            "context": 128000,
            "output": 8192
          },
          "options": {},
          "headers": {},
          "variants": {
            "high": {},
            "low": {}
          }
        }
      },
      "whitelist": ["model-a", "model-b"],
      "blacklist": ["model-c"]
    }
  }
}
```

**Provider Info 字段**（`packages/opencode/src/config/provider.ts`）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `api` | string | OpenAI 兼容端点 URL |
| `name` | string | UI 显示名 |
| `env` | string[] | 环境变量名数组（按序取首个有值） |
| `options.apiKey` | string | 直接配置 API Key（优先级高于 env） |
| `options.baseURL` | string | 自定义 base URL |
| `options.timeout` | number \| false | 请求超时（ms），`false` 禁用超时 |
| `options.chunkTimeout` | number | SSE 流 chunk 间隔超时（ms） |
| `options.setCacheKey` | boolean | 启用 `promptCacheKey` |
| `models` | object | 模型覆盖配置，key 为本地盘 ID，value 含远程模型 ID 和特性声明 |
| `whitelist` | string[] | 允许使用的模型白名单 |
| `blacklist` | string[] | 禁用的模型黑名单 |

### Agent / Mode / Command 配置

```json
{
  "agent": {
    "default": {
      "model": "openai/gpt-4o",
      "description": "Description",
      "tools": {},
      "systemPrompt": "Custom system prompt"
    }
  },
  "mode": {
    "architect": {
      "hint": "Mode hint text"
    }
  },
  "command": {
    "lint": {
      "text": "Run linting on the project"
    }
  }
}
```

### 插件配置

```json
{
  "plugin": [
    {
      "source": "npm:@myorg/opencode-plugin",
      "config": { "key": "value" }
    }
  ]
}
```

### 其他顶层键

| 键 | 说明 |
|----|------|
| `model` | 默认模型（`provider/model` 格式） |
| `enabled_providers` | 启用的 provider 列表 |
| `auth_override` | auth 覆盖配置 |
| `$schema` | JSON Schema URL，`https://opencode.ai/config.json` |

---

## 四、配置变量替换

配置文件支持 `{env:VAR}` 和 `{file:path}` 替换语法（`packages/opencode/src/config/paths.ts`）：

### 环境变量替换

```json
{
  "provider": {
    "openai": {
      "options": {
        "apiKey": "{env:OPENAI_API_KEY}"
      }
    }
  }
}
```

### 文件引用替换

```json
{
  "agent": {
    "default": {
      "systemPrompt": "{file:./system-prompt.md}"
    }
  }
}
```

`{file:...}` 中：
- 相对路径相对于配置文件所在目录解析
- `~/` 展开为用户 home
- 注释行中的 `{file:...}` 不展开（`//` 开头）
- 文件不存在时默认报错，可配置为返回空字符串

---

## 五、全局路径（WOPAL_HOME 定制）

Ellamaka 是 OpenCode 的定制 fork，通过 `WOPAL_HOME` 环境变量覆盖全局数据目录。

| 路径 | 默认值 | 说明 |
|------|--------|------|
| `Global.Path.home` | `os.homedir()` | 用户 home（可被 `OPENCODE_TEST_HOME` 覆盖） |
| `Global.Path.data` | `~/.wopal/ellamaka/data` | 数据目录 |
| `Global.Path.config` | `~/.wopal/config` | **全局配置目录**（含全局 `settings.jsonc`） |
| `Global.Path.cache` | `~/.wopal/ellamaka/cache` | 缓存目录 |
| `Global.Path.state` | `~/.wopal/ellamaka/state` | 状态目录（含 flock） |
| `Global.Path.log` | `~/.wopal/ellamaka/data/log` | 日志目录 |
| `Global.Path.bin` | `~/.wopal/ellamaka/cache/bin` | 二进制下载目录 |

设置 `WOPAL_HOME=/custom/path` → `config` 前缀变为 `/custom/path/config/`，`data`/`cache`/`state` 前缀变为 `/custom/path/ellamaka/`。

> **注意**：`Global.Path.config`（`~/.wopal/config/`）是**纯配置目录**，仅存放 `settings.jsonc` 等配置文件。两种模式下都不在该目录加载 agents、commands、plugins 或执行依赖安装。
>
> 能力扫描和插件依赖安装在 `$WOPAL_HOME` **根目录**（即 `Global.Path.wopalHome`，通常是 `~/.wopal/`）进行——该目录下的 capability 子目录（agents/commands/plugins/skills）被扫描，且为其中的本地插件安装 `file:` 依赖。

---

## 六、`run` 命令配置实践

`run` 命令（`packages/opencode/src/cli/cmd/run.ts`）本身不定义配置参数，通过环境变量间接控制：

| 场景 | 命令 |
|------|------|
| 指定配置文件 | `OPENCODE_CONFIG=/path/to/opencode.json ellamaka run "prompt"` |
| 内联配置 | `OPENCODE_CONFIG_CONTENT='{"provider":{"openai":{"options":{"apiKey":"sk-xxx"}}}}' ellamaka run "prompt"` |
| 指定配置目录 | `OPENCODE_CONFIG_DIR=/path/to/config-dir ellamaka run "prompt"` |
| 连接远程 server | `ellamaka run "prompt" --attach http://remote:4096 --password secret` |
| 跳过权限询问 | `ellamaka run "prompt" --dangerously-skip-permissions` |
| 指定模型 | `ellamaka run "prompt" --model openai/gpt-4o` |

### run 命令完整参数

| 参数 | 别名 | 类型 | 说明 |
|------|------|------|------|
| `--model` | `-m` | string | 模型（`provider/model` 格式） |
| `--agent` | — | string | 使用的 agent |
| `--variant` | — | string | 模型 variant（如 `high`, `max`, `minimal`） |
| `--format` | — | string | 输出格式：`default` 或 `json` |
| `--file` | `-f` | string[] | 附件文件 |
| `--command` | — | boolean | 以命令模式执行 |
| `--title` | — | string | session 标题 |
| `--dir` | — | string | 工作目录 |
| `--attach` | — | string | 连接远程 server URL |
| `--password` | `-p` | string | Basic auth 密码 |
| `--port` | — | number | 本地 server 端口 |
| `--share` | — | boolean | 分享 session |
| `--thinking` | — | boolean | 显示 thinking 块 |
| `--dangerously-skip-permissions` | — | boolean | 自动批准权限 |
| `--fork` | — | boolean | 创建 fork 分支 |
| `--continue` | — | boolean | 继续已有 session |
| `--session` | — | string | 指定 session ID |
| `--repo` | — | string | GitHub 仓库 |

---

## 七、认证方式汇总

| 方式 | 适用场景 | 说明 |
|------|---------|------|
| 环境变量 | provider 级别 | 如 `OPENAI_API_KEY`，provider `env` 字段声明 |
| `opencode.json` `options.apiKey` | provider 级别 | 配置文件中直接指定 |
| `ellamaka auth login <provider>` | OAuth provider | 交互式登录，凭证存入本地数据库 |
| `--password` + `--attach` | 远程 server | HTTP Basic Auth 连接已有 server |
| `OPENCODE_SERVER_PASSWORD` | 远程 server | 环境变量替代 `--password` |

---

## 八、调试与验证

### 查看当前配置

```bash
# 查看已配置的 providers
ellamaka providers list

# 查看已登录的 provider 认证状态
ellamaka providers login

# 查看可用模型
ellamaka models list
```

### 日志输出

- `--print-logs`：日志写入 stderr 而非文件
- 默认日志路径：`~/.wopal/ellamaka/data/log/<ISO_TIMESTAMP>.log`
- 自动轮换，保留最近 10 个文件
- 本地/dev 安装默认日志级别为 `DEBUG`，生产为 `INFO`

### 日志中定位配置问题

搜索日志中 `loaded config` 相关条目：
- `loaded custom config` → `OPENCODE_CONFIG` 生效
- `loaded custom config from OPENCODE_CONFIG_CONTENT` → 内联配置生效
- `loading config from OPENCODE_CONFIG_DIR` → 配置目录生效
- `loaded remote config from well-known` → 远程配置生效

---

## 九、Agent Permission 与 Skill 可见性

### _PERMISSION 评估机制

Permission 系统通过规则列表（ruleset）评估，核心是 `findLast` — 遍历全部规则，**返回最后一个匹配的规则**。

```typescript
// packages/opencode/src/permission/evaluate.ts
export function evaluate(permission: string, pattern: string, ...rulesets: Rule[][]): Rule {
  const match = rules.findLast(
    (rule) => Wildcard.match(permission, rule.permission) && Wildcard.match(pattern, rule.pattern),
  )
  return match ?? { action: "ask", permission, pattern: "*" }
}
```

**关键特性**：后声明的规则优先级更高。`Wildcard.match` 支持 `*` 通配符（匹配任意字符串）。

### Skill 可见性过滤

`skill/index.ts` 中 `available` 函数通过 permission 评估决定每个 agent 能看到哪些 skill：

```typescript
list.filter((skill) => Permission.evaluate("skill", skill.name, agent.permission).action !== "deny")
```

- `deny` → 从列表移除（agent 看不到）
- `allow` 或 `ask` → 保留（agent 可见）

### Permission 配置格式

Agent 的 permission 在配置中支持两种写法：

**简写**（对所有目标生效）：
```json
{ "skill": "deny" }
```
→ 转换为 `{ permission: "skill", pattern: "*", action: "deny" }`

**详细写法**（按目标分别指定）：
```json
{ "skill": { "*": "deny", "git-worktrees": "allow", "fae-collab": "allow" } }
```
→ 转换为 ruleset，`Object.entries` 按插入序遍历，`findLast` 取最后匹配

### 配置方式与优先级

##### wopal-space 模式下的完整合并链

wopal-space 模式下 permission 按以下层级逐层合并（优先级从低到高）：

| 层级 | 来源 | 说明 |
|------|------|------|
| 1 | 内置默认 | 硬编码的 allow/ask 规则 |
| 2 | `WOPAL_HOME/config/settings.jsonc` | 全局配置中的 `ellamaka.permission` |
| 3 | `.wopal/config/settings.json[c]` | 空间配置中的 `ellamaka.permission` / `ellamaka.agent.<name>.permission` |
| 4 | `.wopal/agents/{name}.md` | agent frontmatter 中的 `permission` 字段（**最高优先级**） |

合并规则：`Permission.merge` 数组扁平，`findLast` 最后一条匹配生效。

Agent permission 有两种配置入口：

1. **JSON 配置**（`settings.jsonc` 的 `ellamaka.agent.<name>.permission`）
2. **Markdown 配置**（`agent/<name>.md` 的 frontmatter `permission`）

**加载顺序**：先 JSON，后 Markdown。合并使用 `mergeDeep`：

| 场景 | JSON | MD | 合并结果 |
|------|------|-----|---------|
| 互补 | `{ "*": "deny", "a": "allow" }` | `{ "b": "allow" }` | `{ "*": "deny", "a": "allow", "b": "allow" }` |
| 同键覆盖 | `{ "*": "deny", "a": "allow" }` | `{ "*": "ask" }` | `{ "*": "ask", "a": "allow" }` |

**结论**：Markdown 配置优先级更高（同键覆盖 JSON），但不会删除 JSON 中独有的键。

### Wopal-Space 模式下的 Skill 加载

wopal-space 模式下，skill 按以下优先级加载（低→高，同名高优先级覆盖低优先级）：

1. `~/.agents/skills/`（外部 agent skill，最低优先级）
2. `~/.wopal/skills/`（全局能力目录）
3. `<WOPAL_SPACE_ROOT>/.wopal/skills/`（空间能力目录，最高优先级）
4. 配置中 `skills.paths` 指定的额外路径
5. 配置中 `skills.urls` 拉取的远程技能

Claude Code 技能（`~/.claude/skills/`）和 Claude Code 提示词在 wopal-space 模式下自动排除，无需手动设置环境变量。

> `~/.wopal/config/` 是纯配置目录，不扫描 skills/agents/commands 等能力。

### 子代理 Skill 白名单配置实践

利用 `"*": "deny"` 通配 + 具体技能 `"allow"` 的组合，可实现子代理技能白名单：

**JSON 配置**（`.wopal/config/settings.jsonc`）：

```jsonc
{
  "ellamaka": {
    "agent": {
      "fae": {
        "model": "anthropic/claude-sonnet-4-20250514",
        "permission": {
          "skill": {
            "*": "deny",
            "git-worktrees": "allow",
            "fae-collab": "allow"
          }
        }
      }
    }
  }
}
```

效果：fae 只能看到 `git-worktrees` 和 `fae-collab` 两个技能，其余全部隐藏。

**Markdown 配置**（`.wopal/agents/fae.md`）：

```markdown
---
name: fae
permission:
  skill:
    "*": deny
    git-worktrees: allow
    fae-collab: allow
---
Fae agent prompt...
```

**优先级规则**：
- MD 和 JSON 同时配置时，相同键 MD 覆盖 JSON，不同键合并保留
- 推荐做法：JSON 做统一配置中心，MD 只写 prompt/model 等非 permission 字段
