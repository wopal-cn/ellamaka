import type { Configuration } from "electron-builder"

const channel = (() => {
  const raw = process.env.OPENCODE_CHANNEL
  if (raw === "main" || raw === "beta" || raw === "prod") return raw
  return "main"
})()

// 版本真相源 = 本包 package.json（docs/DISTRIBUTION.md §3.2）。release 构建
// 让 electron-builder 原生读它的 version（CI 已校验 tag == 锚点文件），
// 只有非 release 构建（dev stamp）才用 OPENCODE_VERSION 覆盖。
const isRelease = process.env.OPENCODE_RELEASE === "true"
const version = isRelease ? undefined : process.env.OPENCODE_VERSION?.trim()
const build = process.env.OPENCODE_BUILD_ID?.trim()
const buildVersion = build ? build.slice(0, 12) : undefined
const electronDist = process.env.ELECTRON_DIST?.trim()

function getPublishUrl(): string | undefined {
  if (channel === "beta") return "https://download.coursedao.com/ellamaka-desktop/beta/latest"
  if (channel === "prod") return "https://download.coursedao.com/ellamaka-desktop/latest"
  return undefined
}

const packageName = (() => {
  if (channel === "beta") return "ellamaka-beta"
  if (channel === "main") return "ellamaka-main"
  return "ellamaka"
})()

const artifactPrefix = channel === "beta" ? "ellamaka-desktop-beta" : "ellamaka-desktop"

const getBase = (): Configuration => ({
  ...(electronDist ? { electronDist } : {}),
  ...(buildVersion ? { buildVersion } : {}),
  artifactName: `${artifactPrefix}-\${os}-\${arch}.\${ext}`,
  copyright: "Copyright © 2025 Ellamaka",
  extraMetadata: {
    name: packageName,
    ...(version ? { version } : {}),
    ...(build ? { ellamakaBuild: build } : {}),
  },
  directories: {
    output: "dist",
    buildResources: "resources",
  },
  files: ["out/**/*", "resources/**/*", "!resources/release-identity.json"],
  extraResources: [
    {
      from: "native/",
      to: "native/",
      filter: ["index.js", "index.d.ts", "build/Release/mac_window.node", "swift-build/**"],
    },
    {
      // release-identity.json must live outside app.asar (Contents/Resources)
      // so external consumers (wopal-cli) can probe the embedded identity.
      from: "resources/release-identity.json",
      to: "release-identity.json",
    },
  ],
  mac: {
    category: "public.app-category.developer-tools",
    icon: "resources/icons/icon.icns",
    identity: "-",
    hardenedRuntime: false,
    gatekeeperAssess: false,
    entitlements: "resources/entitlements.plist",
    entitlementsInherit: "resources/entitlements.plist",
    notarize: false,
    target: ["dmg", "zip"],
    artifactName: `${artifactPrefix}-\${os}-\${arch}.\${ext}`,
  },
  dmg: {
    sign: false,
  },
  protocols: {
    name: "Ellamaka",
    schemes: ["ellamaka"],
  },
  win: {
    icon: "resources/icons/icon.ico",
    target: ["nsis"],
    verifyUpdateCodeSignature: false,
    executableName: "ellamaka",
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    installerIcon: "resources/icons/icon.ico",
    installerHeaderIcon: "resources/icons/icon.ico",
  },
  linux: {
    icon: "resources/icons",
    category: "Development",
    target: ["AppImage", "deb"],
    artifactName: `${artifactPrefix}-\${os}-\${arch}.\${ext}`,
    executableName: "ellamaka",
  },
})

function getConfig(): Configuration {
  const base = getBase()
  const publishUrl = getPublishUrl()
  const publish = publishUrl ? { provider: "generic" as const, url: publishUrl, channel: "latest" } : undefined

  switch (channel) {
    case "main": {
      return {
        ...base,
        appId: "ai.ellamaka.desktop.main",
        productName: "Ellamaka Main",
      }
    }
    case "beta": {
      return {
        ...base,
        appId: "ai.ellamaka.desktop.beta",
        productName: "Ellamaka Beta",
        publish,
        protocols: { name: "Ellamaka Beta", schemes: ["ellamaka"] },
      }
    }
    case "prod": {
      return {
        ...base,
        appId: "ai.ellamaka.desktop",
        productName: "Ellamaka",
        publish,
        protocols: { name: "Ellamaka", schemes: ["ellamaka"] },
      }
    }
  }
  throw new Error("Unsupported desktop channel")
}

export default getConfig()
