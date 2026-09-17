export interface OntologySourceOption {
  id: string
  name: string
  description: string
  advanced: boolean
}

export interface OntologyModeOption {
  id: "fork" | "clone"
  name: string
  summary: string
  recommended: boolean
  requiresGithubAuth: boolean
}

export const ONTOLOGY_SOURCES: readonly OntologySourceOption[] = [
  {
    id: "official",
    name: "WopalSpace 官方本体",
    description: "适合大多数用户，持续获得官方能力更新。",
    advanced: false,
  },
  {
    id: "custom",
    name: "其他 Git 仓库",
    description: "使用团队或社区维护的能力本体。",
    advanced: true,
  },
]

export const ONTOLOGY_MODES: readonly OntologyModeOption[] = [
  {
    id: "fork",
    name: "Fork 到我的 GitHub",
    summary: "保留个人远程副本，可跨设备同步并贡献改进",
    recommended: true,
    requiresGithubAuth: true,
  },
  {
    id: "clone",
    name: "仅保存在本机",
    summary: "无需 GitHub；本地改动不会自动备份或同步",
    recommended: false,
    requiresGithubAuth: false,
  },
]
