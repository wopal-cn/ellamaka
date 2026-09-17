/**
 * zh-CN content configuration for the onboarding wizard.
 *
 * All user-facing copy lives here. Components read from this config
 * instead of hardcoding strings. A future en-US resource can be added
 * alongside this file without touching components.
 */

export interface StepContent {
  /** Full step title shown in the card header. */
  title: string
  /** Short title used in the step tracker. */
  shortTitle: string
  /** One-sentence goal of this step. */
  goal: string
  /** Why this step is necessary. */
  why: string
  /** Estimated time hint. */
  duration: string
  /** What the user gets after success. */
  outcome: string
  /** Optional notes or warnings. */
  notes?: string
}

export interface OnboardingContent {
  locale: "zh-CN"
  steps: Record<string, StepContent>
  actions: {
    back: string
    next: string
    skip: string
    retry: string
    cancel: string
    start: string
    continue: string
    recheck: string
    copy: string
    clear: string
    close: string
    save: string
  }
  status: {
    working: string
    success: string
    error: string
    skipped: string
  }
  errors: {
    title: string
    impact: string
    action: string
    technicalDetails: string
  }
  memory: {
    enableLabel: string
    enableDescription: string
    globalScope: string
    disabledHint: string
    llmSection: string
    llmSectionDesc: string
    llmEndpointLabel: string
    llmEndpointPlaceholder: string
    llmModelLabel: string
    llmModelPlaceholder: string
    llmKeyLabel: string
    llmKeyPlaceholder: string
    llmKeySaved: string
    embeddingSection: string
    embeddingSectionDesc: string
    reuseLabel: string
    reuseDescription: string
    embeddingEndpointLabel: string
    embeddingEndpointPlaceholder: string
    embeddingModelLabel: string
    embeddingModelPlaceholder: string
    embeddingKeyLabel: string
    embeddingKeyPlaceholder: string
    embeddingKeySaved: string
    probing: string
    probeFailed: string
    verifyFailed: string
    saveButton: string
    saving: string
    resultTitle: string
    resultStatus: string
    resultScopeLabel: string
    resultOutcome: string
    resultEnabled: string
    resultDisabled: string
    resultScope: string
    resultOutcomeCreated: string
    resultOutcomeUpdated: string
    resultOutcomeReused: string
    resultLlmEndpoint: string
    resultLlmModel: string
    resultLlmKeySaved: string
    resultEmbeddingEndpoint: string
    resultEmbeddingModel: string
    resultEmbeddingKeySaved: string
    resultEnvPath: string
    notConfigured: string
  }
}

export const zhCN: OnboardingContent = {
  locale: "zh-CN",
  steps: {
    "system-check": {
      title: "选择安装目录",
      shortTitle: "安装目录",
      goal: "初始化 WOPAL_HOME 工作主目录并校验基础运行环境。",
      why: "为您准备高效的全流程 AI 智能协同与超级个体工作空间，确保 Git、网络和磁盘空间就绪。",
      duration: "约 10 秒",
      outcome: "环境检查报告，确认系统可以安全安装。",
    },
    "install-cli": {
      title: "组件安装",
      shortTitle: "组件安装",
      goal: "准备 Wopal CLI 工具链与 Ellamaka 运行时引擎",
      why: "下载并校验基础工具链与 AI 引擎，为后续空间与代理调度提供核心能力。",
      duration: "约 1 分钟",
      outcome: "Wopal CLI 与 Ellamaka 引擎安装校验就绪。",
    },
    "install-wopal-cli": {
      title: "安装 Wopal CLI",
      shortTitle: "Wopal CLI",
      goal: "下载并安装 wopal 核心命令行工具",
      why: "Wopal CLI 是管理空间、本体和引擎的基础工具，所有后续操作都依赖它。",
      duration: "约 30 秒",
      outcome: "wopal 二进制可用，版本号确认。",
    },
    "install-ellamaka-cli": {
      title: "安装 Ellamaka 引擎",
      shortTitle: "Ellamaka",
      goal: "下载并配置 Ellamaka AI 引擎",
      why: "Ellamaka 是执行 AI 任务的运行时引擎，负责代码生成和代理调度。",
      duration: "约 1-2 分钟",
      outcome: "引擎二进制可用，版本和 channel 确认。",
    },
    "github-auth": {
      title: "GitHub 认证",
      shortTitle: "GitHub",
      goal: "连接 GitHub 账号以同步本体仓库",
      why: "Fork 模式需要 GitHub 认证来创建和管理你的个人本体副本。",
      duration: "约 20 秒",
      outcome: "GitHub Token 配置完成，可以 Fork 和 Clone。",
      notes: "跳过此步骤将只能使用 Clone 模式。",
    },
    "ai-provider": {
      title: "配置 OpenCode Go",
      shortTitle: "OpenCode Go",
      goal: "订阅 OpenCode Go 并配置 API Key",
      why: "注册并订阅 OpenCode Go 后，在控制台创建 API Key，再复制到右侧输入框。",
      duration: "约 2-3 分钟",
      outcome: "可在 Ellamaka 中选择中国当前前沿大模型。",
      notes: "跳过后仍可使用 Ellamaka 默认免费模型。当前优惠期首月 5 美元，后续 10 美元/月，可随时取消订阅。",
    },
    "ontology-setup": {
      title: "配置空间能力本体",
      shortTitle: "能力本体",
      goal: "选择能力来源与同步方式",
      why: "Fork 会保留并同步你的能力演化；Clone 只保存在当前电脑。",
      duration: "约 1-3 分钟",
      outcome: "能力本体准备完成，可直接用于创建空间。",
      notes: "已有本体只复用，不在配置向导中自动迁移模式。",
    },
    "runtime-setup": {
      title: "安装配置本体能力",
      shortTitle: "本体能力",
      goal: "检查并将能力本体安全配置到 WOPAL_HOME",
      why: "Ellamaka 从 WOPAL_HOME 加载全局设置、辅助脚本和六类基础能力。",
      duration: "通常只需几秒",
      outcome: "完成配置复检，并展示每项能力的新建、修复或复用结果。",
    },
    "create-space": {
      title: "创建工作空间",
      shortTitle: "工作空间",
      goal: "创建你的第一个 WopalSpace 工作空间",
      why: "工作空间是项目协作和记忆隔离的基本单元。",
      duration: "约 20 秒",
      outcome: "空间注册完成，可以开始工作。",
    },
    "memory-config": {
      title: "记忆系统配置",
      shortTitle: "记忆系统",
      goal: "配置长期记忆和向量嵌入端点",
      why: "记忆系统让代理能够跨会话保留上下文和学习成果。",
      duration: "约 30 秒",
      outcome: "记忆后端配置完成，嵌入模型就绪。",
      notes: "跳过此步骤将禁用长期记忆功能。",
    },
    "star-guide": {
      title: "社区与支持",
      shortTitle: "社区",
      goal: "了解开源社区和支持渠道",
      why: "Star 项目、阅读文档和加入社区可以帮助你更好地使用 WopalSpace。",
      duration: "约 10 秒",
      outcome: "了解资源链接，完成向导。",
    },
    done: {
      title: "设置完成",
      shortTitle: "完成",
      goal: "确认所有组件就绪并启动工作台",
      why: "最终健康检查确保引擎、本体、设置、能力和空间全部可用。",
      duration: "即时",
      outcome: "进入 WopalSpace 工作台，开始智能协作。",
    },
  },
  actions: {
    back: "上一步",
    next: "下一步",
    skip: "跳过",
    retry: "重试",
    cancel: "取消",
    start: "开始",
    continue: "继续",
    recheck: "重新检查",
    copy: "复制",
    clear: "清空",
    close: "关闭",
    save: "保存记忆配置",
  },
  status: {
    working: "正在处理，请稍候…",
    success: "完成",
    error: "出错",
    skipped: "已跳过",
  },
  errors: {
    title: "发生了什么",
    impact: "有什么影响",
    action: "如何处理",
    technicalDetails: "技术详情",
  },
  memory: {
    enableLabel: "启用长期记忆",
    enableDescription: "让代理跨会话保留偏好、项目约定和构建上下文。",
    globalScope: "全局配置 · 所有 Space 默认继承",
    disabledHint: "长期记忆已关闭。你可以随时重新启用以保留已有配置。",
    llmSection: "记忆整理模型",
    llmSectionDesc: "用于会话摘要和记忆蒸馏的 LLM 配置。",
    llmEndpointLabel: "LLM API 端点",
    llmEndpointPlaceholder: "https://api.openai.com/v1",
    llmModelLabel: "LLM 模型",
    llmModelPlaceholder: "gpt-4o-mini",
    llmKeyLabel: "LLM API Key",
    llmKeyPlaceholder: "sk-...",
    llmKeySaved: "已保存",
    embeddingSection: "语义检索模型",
    embeddingSectionDesc: "用于记忆向量搜索的 Embedding 配置。",
    reuseLabel: "复用上面的服务和 Key",
    reuseDescription: "Embedding 使用与 LLM 相同的 API 端点和 Key。",
    embeddingEndpointLabel: "Embedding API 端点",
    embeddingEndpointPlaceholder: "https://api.openai.com/v1",
    embeddingModelLabel: "Embedding 模型",
    embeddingModelPlaceholder: "text-embedding-3-small",
    embeddingKeyLabel: "Embedding API Key",
    embeddingKeyPlaceholder: "留空使用本地默认值",
    embeddingKeySaved: "已保存",
    probing: "正在检查记忆配置…",
    probeFailed: "无法读取现有记忆配置，请重试后再保存。",
    verifyFailed: "保存后复检未通过，请检查技术详情后重试。",
    saveButton: "保存记忆配置",
    saving: "正在保存…",
    resultTitle: "记忆配置已保存",
    resultStatus: "状态",
    resultScopeLabel: "作用域",
    resultOutcome: "结果",
    resultEnabled: "已启用",
    resultDisabled: "已关闭",
    resultScope: "全局 · 所有 Space 默认继承",
    resultOutcomeCreated: "新建",
    resultOutcomeUpdated: "已更新",
    resultOutcomeReused: "未变更",
    resultLlmEndpoint: "LLM 端点",
    resultLlmModel: "LLM 模型",
    resultLlmKeySaved: "LLM 密钥",
    resultEmbeddingEndpoint: "Embedding 端点",
    resultEmbeddingModel: "Embedding 模型",
    resultEmbeddingKeySaved: "Embedding 密钥",
    resultEnvPath: "配置文件",
    notConfigured: "未配置",
  },
}
