import { existsSync } from "fs"
import os from "os"
import path from "path"
import * as Log from "@wopal/ellamaka-core/util/log"
import { Process } from "@/util/process"

const log = Log.create({ service: "config" })

const MANAGED_PLIST_DOMAIN = "ai.wopal.managed"

// Keys injected by macOS/MDM into the managed plist that are not OpenCode config
const PLIST_META = new Set([
  "PayloadDisplayName",
  "PayloadIdentifier",
  "PayloadType",
  "PayloadUUID",
  "PayloadVersion",
  "_manualProfile",
])

function systemManagedConfigDir(): string {
  switch (process.platform) {
    case "darwin":
      return "/Library/Application Support/wopal"
    case "win32":
      return path.join(process.env.ProgramData || "C:\\ProgramData", "wopal")
    default:
      return "/etc/wopal"
  }
}

function managedConfigDir() {
  return process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR || systemManagedConfigDir()
}

function parseManagedPlist(json: string): string {
  const raw = JSON.parse(json)
  for (const key of Object.keys(raw)) {
    if (PLIST_META.has(key)) delete raw[key]
  }
  return JSON.stringify(raw)
}

async function readManagedPreferences() {
  if (process.platform !== "darwin") return

  const user = (() => {
    try {
      return os.userInfo().username || "user"
    } catch (err) {
      log.warn("failed to read system username, using fallback", { err })
      return "user"
    }
  })()
  const paths = [
    path.join("/Library/Managed Preferences", user, `${MANAGED_PLIST_DOMAIN}.plist`),
    path.join("/Library/Managed Preferences", `${MANAGED_PLIST_DOMAIN}.plist`),
  ]

  for (const plist of paths) {
    if (!existsSync(plist)) continue
    log.info("reading macOS managed preferences", { path: plist })
    const result = await Process.run(["plutil", "-convert", "json", "-o", "-", plist], { nothrow: true })
    if (result.code !== 0) {
      log.warn("failed to convert managed preferences plist", { path: plist })
      continue
    }
    return {
      source: `mobileconfig:${plist}`,
      text: parseManagedPlist(result.stdout.toString()),
    }
  }

  return
}

export const ConfigManaged = {
  managedConfigDir,
  parseManagedPlist,
  readManagedPreferences,
}
