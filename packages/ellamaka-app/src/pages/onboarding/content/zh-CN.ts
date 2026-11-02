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
    "github-auth": {
      title: "GitHub 身份",
      shortTitle: "GitHub",
      goal: "检测本机 GitHub 登录，为 Fork 模式准备身份",
      why: "Fork 模式使用本机 gh 登录创建和管理你的个人本体副本；选择 Clone 则不需要 GitHub 登录。",
      duration: "约 20 秒",
      outcome: "本机 gh 身份可用，可以进入能力本体安装并使用 Fork。",
      notes: "如果不希望登录 GitHub，可明确选择 Clone 继续。",
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
      why: "已连接 GitHub 时默认 Fork，并仍可选择 Clone；未连接 GitHub 时只提供 Clone。",
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
    "runtime-preparation": {
      title: "准备运行环境",
      shortTitle: "运行环境",
      goal: "下载并准备这份构建运行所需的本地依赖",
      why: "运行时的闭包、Home 目录与能力配置需要完整就位，工作台和工具才能启动。",
      duration: "首次约数十秒",
      outcome: "运行时准备完成，进入工作台即可直接使用。",
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
      goal: "确认 WopalSpace 初始化完成并启动工作台",
      why: "Server 会重新检查工作目录、能力本体和空间事实，再保存完成状态。",
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
}
