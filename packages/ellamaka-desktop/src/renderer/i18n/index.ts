import * as i18n from "@solid-primitives/i18n"

import { dict as desktopEn } from "./en"
import { dict as desktopZh } from "./zh"
import { dict as desktopZht } from "./zht"
import { dict as desktopKo } from "./ko"
import { dict as desktopDe } from "./de"
import { dict as desktopEs } from "./es"
import { dict as desktopFr } from "./fr"
import { dict as desktopDa } from "./da"
import { dict as desktopJa } from "./ja"
import { dict as desktopPl } from "./pl"
import { dict as desktopRu } from "./ru"
import { dict as desktopUk } from "./uk"
import { dict as desktopAr } from "./ar"
import { dict as desktopNo } from "./no"
import { dict as desktopBr } from "./br"
import { dict as desktopBs } from "./bs"

// The Electron shell translates only its own chrome (dialogs, updater, CLI
// install). It never renders App copy: the shared renderer owns that through
// `loadLocaleDict`, which loads App dictionaries on demand. Importing the App
// dictionaries here would do the opposite — it pins all 16 of them into the
// shell's entry chunk as static imports and cancels their code splitting.
export type Locale =
  | "en"
  | "zh"
  | "zht"
  | "ko"
  | "de"
  | "es"
  | "fr"
  | "da"
  | "ja"
  | "pl"
  | "ru"
  | "uk"
  | "ar"
  | "no"
  | "br"
  | "bs"

type Dictionary = i18n.Flatten<typeof desktopEn>

const LOCALES: readonly Locale[] = [
  "en",
  "zh",
  "zht",
  "ko",
  "de",
  "es",
  "fr",
  "da",
  "ja",
  "pl",
  "ru",
  "uk",
  "bs",
  "ar",
  "no",
  "br",
]

function detectLocale(): Locale {
  if (typeof navigator !== "object") return "en"

  const languages = navigator.languages?.length ? navigator.languages : [navigator.language]
  for (const language of languages) {
    if (!language) continue
    if (language.toLowerCase().startsWith("en")) return "en"
    if (language.toLowerCase().startsWith("zh")) {
      if (language.toLowerCase().includes("hant")) return "zht"
      return "zh"
    }
    if (language.toLowerCase().startsWith("ko")) return "ko"
    if (language.toLowerCase().startsWith("de")) return "de"
    if (language.toLowerCase().startsWith("es")) return "es"
    if (language.toLowerCase().startsWith("fr")) return "fr"
    if (language.toLowerCase().startsWith("da")) return "da"
    if (language.toLowerCase().startsWith("ja")) return "ja"
    if (language.toLowerCase().startsWith("pl")) return "pl"
    if (language.toLowerCase().startsWith("ru")) return "ru"
    if (language.toLowerCase().startsWith("uk")) return "uk"
    if (language.toLowerCase().startsWith("ar")) return "ar"
    if (
      language.toLowerCase().startsWith("no") ||
      language.toLowerCase().startsWith("nb") ||
      language.toLowerCase().startsWith("nn")
    )
      return "no"
    if (language.toLowerCase().startsWith("pt")) return "br"
    if (language.toLowerCase().startsWith("bs")) return "bs"
  }

  return "en"
}

function parseLocale(value: unknown): Locale | null {
  if (!value) return null
  if (typeof value !== "string") return null
  if ((LOCALES as readonly string[]).includes(value)) return value as Locale
  return null
}

function parseRecord(value: unknown) {
  if (!value || typeof value !== "object") return null
  if (Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function parseStored(value: unknown) {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

function pickLocale(value: unknown): Locale | null {
  const direct = parseLocale(value)
  if (direct) return direct

  const record = parseRecord(value)
  if (!record) return null

  return parseLocale(record.locale)
}

const base = i18n.flatten(desktopEn)

const DICTIONARIES: Record<Locale, () => Dictionary> = {
  en: () => base,
  zh: () => ({ ...base, ...i18n.flatten(desktopZh) }),
  zht: () => ({ ...base, ...i18n.flatten(desktopZht) }),
  ko: () => ({ ...base, ...i18n.flatten(desktopKo) }),
  de: () => ({ ...base, ...i18n.flatten(desktopDe) }),
  es: () => ({ ...base, ...i18n.flatten(desktopEs) }),
  fr: () => ({ ...base, ...i18n.flatten(desktopFr) }),
  da: () => ({ ...base, ...i18n.flatten(desktopDa) }),
  ja: () => ({ ...base, ...i18n.flatten(desktopJa) }),
  pl: () => ({ ...base, ...i18n.flatten(desktopPl) }),
  ru: () => ({ ...base, ...i18n.flatten(desktopRu) }),
  uk: () => ({ ...base, ...i18n.flatten(desktopUk) }),
  ar: () => ({ ...base, ...i18n.flatten(desktopAr) }),
  no: () => ({ ...base, ...i18n.flatten(desktopNo) }),
  br: () => ({ ...base, ...i18n.flatten(desktopBr) }),
  bs: () => ({ ...base, ...i18n.flatten(desktopBs) }),
}

const state = {
  locale: detectLocale(),
  dict: base as Dictionary,
  init: undefined as Promise<Locale> | undefined,
}

state.dict = DICTIONARIES[state.locale]()

const translate = i18n.translator(() => state.dict, i18n.resolveTemplate)

export function t(key: keyof Dictionary, params?: Record<string, string | number>) {
  return translate(key, params)
}

export function initI18n(): Promise<Locale> {
  const cached = state.init
  if (cached) return cached

  const promise = (async () => {
    const raw = await window.api.storeGet("ellamaka.global.dat", "language").catch(() => null)
    const value = parseStored(raw)
    const next = pickLocale(value) ?? state.locale

    state.locale = next
    state.dict = DICTIONARIES[next]()
    return next
  })().catch(() => state.locale)

  state.init = promise
  return promise
}
