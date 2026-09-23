import type { Pty } from "@wopal/ellamaka-sdk/v2/client"
import { reportWorkbenchError } from "./workbench-error"

export type PtyKind = "tui" | "term" | "split"

type PtySDK = {
  client: {
    pty: {
      get: (input: { ptyID: string }) => Promise<{ data?: Pty }>
      remove: (input: { ptyID: string; directory?: string }) => Promise<{ data?: boolean }>
    }
  }
}

export type PtyReferences = Partial<Record<PtyKind, string | undefined>>

export type PtyPanel = {
  id: string
  tuiPtyId?: string
  termPtyId?: string
  splitPtyId?: string
}

const kinds: PtyKind[] = ["tui", "term", "split"]

export function ptyReferences(panel: PtyPanel): PtyReferences {
  return {
    tui: panel.tuiPtyId,
    term: panel.termPtyId,
    split: panel.splitPtyId,
  }
}

// Structured nested Map: spacePath -> panelId -> kind -> value.
// Replaces the previous `${spacePath}::${panelId}::${kind}` string key + `startsWith`
// reverse lookup, which was fragile when spacePath itself could contain `::`.
type PanelMap<T> = Map<string, Partial<Record<PtyKind, T>>>
type SpaceMap<T> = Map<string, PanelMap<T>>

function ensurePanelMap<T>(spaceMap: SpaceMap<T>, spacePath: string): PanelMap<T> {
  let panelMap = spaceMap.get(spacePath)
  if (!panelMap) {
    panelMap = new Map()
    spaceMap.set(spacePath, panelMap)
  }
  return panelMap
}

function getPanelMap<T>(spaceMap: SpaceMap<T>, spacePath: string): PanelMap<T> | undefined {
  return spaceMap.get(spacePath)
}

function getKindEntry<T>(panelMap: PanelMap<T> | undefined, panelId: string, kind: PtyKind): T | undefined {
  return panelMap?.get(panelId)?.[kind]
}

function setKindEntry<T>(spaceMap: SpaceMap<T>, spacePath: string, panelId: string, kind: PtyKind, value: T | undefined) {
  const panelMap = ensurePanelMap(spaceMap, spacePath)
  const entry = panelMap.get(panelId)
  if (entry) {
    if (value === undefined) {
      delete entry[kind]
      // Cleanup empty panel entries to avoid unbounded growth
      if (kinds.every((k) => entry[k] === undefined)) panelMap.delete(panelId)
    } else {
      entry[kind] = value
    }
  } else if (value !== undefined) {
    const next: Partial<Record<PtyKind, T>> = {}
    next[kind] = value
    panelMap.set(panelId, next)
  }
}

function deleteKindEntry<T>(spaceMap: SpaceMap<T>, spacePath: string, panelId: string, kind: PtyKind) {
  setKindEntry(spaceMap, spacePath, panelId, kind, undefined)
}

function deletePanelEntry<T>(spaceMap: SpaceMap<T>, spacePath: string, panelId: string) {
  getPanelMap(spaceMap, spacePath)?.delete(panelId)
}

function listPanelKeys<T>(spaceMap: SpaceMap<T>, spacePath: string): Array<{ panelId: string; kind: PtyKind }> {
  const panelMap = getPanelMap(spaceMap, spacePath)
  if (!panelMap) return []
  const out: Array<{ panelId: string; kind: PtyKind }> = []
  for (const [panelId, entry] of panelMap) {
    for (const kind of kinds) {
      if (entry[kind] !== undefined) out.push({ panelId, kind })
    }
  }
  return out
}

export class PtyManager {
  private activePtys: SpaceMap<string> = new Map()
  private pendingEnsures: SpaceMap<Promise<string>> = new Map()
  // Maps each PTY id to the directory the backend created it in. This is the
  // directory that must be sent in the `x-opencode-directory` header for any
  // DELETE/GET against that PTY — NOT the workbench spacePath, which can be
  // an empty string (the General space) and does not match the PTY cwd.
  private ptyDirectories = new Map<string, string>()

  delete(spacePath: string, panelId: string, kind: PtyKind) {
    deleteKindEntry(this.activePtys, spacePath, panelId, kind)
    deleteKindEntry(this.pendingEnsures, spacePath, panelId, kind)
  }

  async ensure(opts: {
    spacePath: string
    panelId: string
    kind: PtyKind
    existingPtyId: string | undefined
    sdk: PtySDK
    directory: string
    createFn: () => Promise<string>
  }): Promise<string> {
    if (!opts.existingPtyId) {
      deleteKindEntry(this.activePtys, opts.spacePath, opts.panelId, opts.kind)
    }

    // 1. If we already have a PTY active in memory for this key
    const active = getKindEntry(getPanelMap(this.activePtys, opts.spacePath), opts.panelId, opts.kind)
    if (active) {
      return active
    }

    // 2. If there is already a pending create/probe for this key
    const pending = getKindEntry(getPanelMap(this.pendingEnsures, opts.spacePath), opts.panelId, opts.kind)
    if (pending) {
      return pending
    }

    // 3. Start ensure promise
    const promise = (async () => {
      // 3.1. Probe existing PTY if hint is provided
      if (opts.existingPtyId) {
        try {
          await opts.sdk.client.pty.get({ ptyID: opts.existingPtyId })
          setKindEntry(this.activePtys, opts.spacePath, opts.panelId, opts.kind, opts.existingPtyId)
          this.ptyDirectories.set(opts.existingPtyId, opts.directory)
          return opts.existingPtyId
        } catch {
          // Stale ID, ignore and fall through to create
        }
      }

      // 3.2. Create new PTY
      const newPtyId = await opts.createFn()
      setKindEntry(this.activePtys, opts.spacePath, opts.panelId, opts.kind, newPtyId)
      this.ptyDirectories.set(newPtyId, opts.directory)
      return newPtyId
    })()

    setKindEntry(this.pendingEnsures, opts.spacePath, opts.panelId, opts.kind, promise)
    try {
      return await promise
    } finally {
      const current = getKindEntry(getPanelMap(this.pendingEnsures, opts.spacePath), opts.panelId, opts.kind)
      if (current === promise) {
        deleteKindEntry(this.pendingEnsures, opts.spacePath, opts.panelId, opts.kind)
      }
    }
  }

  async disposePty(opts: {
    spacePath: string
    panelId: string
    kind: PtyKind
    sdk: PtySDK
    knownPtyId?: string
  }): Promise<void> {
    await this.disposeKey(opts.spacePath, opts.panelId, opts.kind, opts.sdk, opts.knownPtyId)
  }

  async disposePanel(spacePath: string, panelId: string, sdk: PtySDK, known: PtyReferences = {}): Promise<void> {
    await Promise.all(kinds.map((kind) => this.disposePty({
      spacePath,
      panelId,
      kind,
      sdk,
      knownPtyId: known[kind],
    })))
    // Panel entry is now empty; remove it from both maps to avoid stale residue.
    deletePanelEntry(this.activePtys, spacePath, panelId)
    deletePanelEntry(this.pendingEnsures, spacePath, panelId)
  }

  async disposeSpace(spacePath: string, sdk: PtySDK, panels: PtyPanel[] = []): Promise<void> {
    // Known PTY ids from the caller's persisted panel state.
    const known = new Map<string, Partial<Record<PtyKind, string>>>()
    for (const panel of panels) {
      const refs = ptyReferences(panel)
      const entry: Partial<Record<PtyKind, string>> = {}
      for (const kind of kinds) {
        const ptyId = refs[kind]
        if (ptyId) entry[kind] = ptyId
      }
      if (Object.keys(entry).length > 0) known.set(panel.id, entry)
    }

    // Collect every (panelId, kind) we know about for this space, from active
    // registry, pending ensures, and caller-provided known ids — deduped.
    const seen = new Set<string>()
    const targets: Array<{ panelId: string; kind: PtyKind }> = []
    const collect = (panelId: string, kind: PtyKind) => {
      const k = `${panelId}\n${kind}`
      if (seen.has(k)) return
      seen.add(k)
      targets.push({ panelId, kind })
    }
    for (const { panelId, kind } of listPanelKeys(this.activePtys, spacePath)) collect(panelId, kind)
    for (const { panelId, kind } of listPanelKeys(this.pendingEnsures, spacePath)) collect(panelId, kind)
    for (const [panelId, entry] of known) {
      for (const kind of kinds) {
        if (entry[kind] !== undefined) collect(panelId, kind)
      }
    }

    await Promise.all(targets.map(({ panelId, kind }) =>
      this.disposeKey(spacePath, panelId, kind, sdk, known.get(panelId)?.[kind]),
    ))

    // Space is being torn down; drop the empty space entry.
    this.activePtys.delete(spacePath)
    this.pendingEnsures.delete(spacePath)
  }

  clearMemoryOnly() {
    this.activePtys.clear()
    this.pendingEnsures.clear()
    this.ptyDirectories.clear()
  }

  private async disposeKey(
    spacePath: string,
    panelId: string,
    kind: PtyKind,
    sdk: PtySDK,
    knownPtyId?: string,
  ): Promise<void> {
    const ptyIds = new Set<string>()
    if (knownPtyId) ptyIds.add(knownPtyId)

    const activePtyId = getKindEntry(getPanelMap(this.activePtys, spacePath), panelId, kind)
    if (activePtyId) ptyIds.add(activePtyId)
    deleteKindEntry(this.activePtys, spacePath, panelId, kind)

    const pending = getKindEntry(getPanelMap(this.pendingEnsures, spacePath), panelId, kind)
    deleteKindEntry(this.pendingEnsures, spacePath, panelId, kind)
    if (pending) {
      const pendingPtyId = await pending.catch(() => undefined)
      if (pendingPtyId) ptyIds.add(pendingPtyId)
      deleteKindEntry(this.activePtys, spacePath, panelId, kind)
    }

    await Promise.all(Array.from(ptyIds, async (ptyId) => {
      try {
        await sdk.client.pty.remove({
          ptyID: ptyId,
          directory: this.ptyDirectories.get(ptyId),
        })
      } catch (err) {
        // 404 PtyNotFoundError is expected when the backend already reaped
        // the session (e.g. the ellamaka TUI process exited and the backend
        // proc.onExit handler called remove(id) before our DELETE arrived).
        // Treat it as idempotent success, not a real error.
        const status = (err as { response?: { status?: number } })?.response?.status
          ?? (err as { cause?: { status?: number } })?.cause?.status
        if (status !== 404) {
          reportWorkbenchError("dispose pty", err, { silent: true })
        }
      }
      this.ptyDirectories.delete(ptyId)
    }))
  }
}

export const ptyManager = new PtyManager()
