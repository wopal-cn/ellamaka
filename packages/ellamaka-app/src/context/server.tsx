import { createSimpleContext } from "@wopal/ui/context"
import { type Accessor, batch, createEffect, createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { Persist, persisted } from "@/utils/persist"
import { authToastGate } from "@/utils/auth-error"

type StoredProject = { worktree: string; expanded: boolean }
type StoredServer = string | ServerConnection.HttpBase | ServerConnection.Http
const HEALTH_POLL_INTERVAL_MS = 10_000

export function normalizeServerUrl(input: string) {
  const trimmed = input.trim()
  if (!trimmed) return
  const withProtocol = /^https?:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`
  return withProtocol.replace(/\/+$/, "")
}

export function serverName(conn?: ServerConnection.Any, ignoreDisplayName = false) {
  if (!conn) return ""
  if (conn.displayName && !ignoreDisplayName) return conn.displayName
  return conn.http.url.replace(/^https?:\/\//, "").replace(/\/+$/, "")
}

function projectsKey(key: ServerConnection.Key) {
  if (key === undefined || key === null) return ""
  if (key === "sidecar") return "local"
  if (isLocalHost(key)) return "local"
  return key
}

function isLocalHost(url: string) {
  const host = url.replace(/^https?:\/\//, "").split(":")[0]
  if (host === "localhost" || host === "127.0.0.1") return "local"
}

export function resolveServerList(input: {
  props?: Array<ServerConnection.Any>
  stored: StoredServer[]
}): Array<ServerConnection.Any> {
  const deduped = new Map<ServerConnection.Key, ServerConnection.Any>(
    input.props?.map((v) => [ServerConnection.key(v), v]) ?? [],
  )

  for (const value of input.stored ?? []) {
    const conn: ServerConnection.Http =
      typeof value === "string"
        ? {
            type: "http" as const,
            http: { url: value },
          }
        : "http" in value
          ? value
          : { type: "http", http: value }
    const key = ServerConnection.key(conn)

    const existing = deduped.get(key)
    if (existing)
      deduped.set(key, {
        ...existing,
        ...conn,
        http: { ...existing.http, ...conn.http },
      })
    else deduped.set(key, conn)
  }

  return [...deduped.values()]
}

/**
 * The persisted credentials seed for startup-injected servers. Servers that
 * arrive through props with a password (the `auth_token` URL exchange, the
 * Desktop sidecar) must survive a page reload: the URL token is cleared right
 * after the first load, so without a persisted copy every later request runs
 * unauthenticated. Writes through the SAME storage the "manage servers" dialog
 * uses (`Persist.global("server")` → `store.list`), so the security posture is
 * identical to a server the user added by hand — one semantics for all
 * credentials. A props server without a password never touches the store, and
 * a fresh launch token overwrites the previous entry (the URL is the newest
 * credential source).
 */
export function seedStoredServers(input: {
  stored: StoredServer[]
  props?: Array<ServerConnection.Any>
}): StoredServer[] {
  const list = [...(input.stored ?? [])]
  let changed = false

  for (const conn of input.props ?? []) {
    if (conn.type !== "http") continue
    const { username, password } = conn.http
    if (!password) continue
    // The authToken flag is a per-load marker, never persisted.
    const entry: StoredServer = { type: "http", http: { url: conn.http.url, ...(username ? { username } : {}), password } }
    const key = ServerConnection.key(conn)
    const index = list.findIndex((x) => {
      const normalized: ServerConnection.Http =
        typeof x === "string" ? { type: "http", http: { url: x } } : "http" in x ? x : { type: "http", http: x }
      return ServerConnection.key(normalized) === key
    })
    if (index !== -1) {
      const existing = list[index]!
      const existingHttp: ServerConnection.HttpBase =
        typeof existing === "string" ? { url: existing } : "http" in existing ? existing.http : existing
      if (existingHttp.password === password && existingHttp.username === username) continue
      list[index] = entry
    } else {
      list.push(entry)
    }
    changed = true
  }

  return changed ? list : input.stored
}


/**
 * The local sidecar URL changes when the desktop process restarts. Persist the
 * symbolic fallback key instead so a prior generation can never become a
 * stale saved selection.
 */
export function normalizeServerSelection(input: {
  fallback: ServerConnection.Key
  key: ServerConnection.Key
  servers: Array<ServerConnection.Any>
}): ServerConnection.Key {
  const selected = input.servers.find((server) => ServerConnection.key(server) === input.key)
  if (selected?.type === "sidecar" && selected.variant === "base") return input.fallback
  return input.key
}

export function resolveStartupServerSelection(input: {
  fallback: ServerConnection.Key
  saved?: ServerConnection.Key
  servers: Array<ServerConnection.Any>
}) {
  if (!input.saved) {
    return {
      active: input.fallback,
      restoringSavedSelection: false,
      persistFallback: false,
    }
  }

  const saved = normalizeServerSelection({
    fallback: input.fallback,
    key: input.saved,
    servers: input.servers,
  })

  if (saved === input.fallback) {
    return {
      active: input.fallback,
      restoringSavedSelection: false,
      persistFallback: saved !== input.saved,
    }
  }

  const available = input.servers.some((server) => ServerConnection.key(server) === saved)
  if (available) {
    return {
      active: saved,
      restoringSavedSelection: true,
      persistFallback: false,
    }
  }

  return {
    active: input.fallback,
    restoringSavedSelection: false,
    persistFallback: true,
  }
}

export namespace ServerConnection {
  type Base = { displayName?: string }

  export type HttpBase = {
    url: string
    username?: string
    password?: string
  }

  // Regular web connections
  export type Http = {
    type: "http"
    http: HttpBase
    authToken?: boolean
  } & Base

  export type Sidecar = {
    type: "sidecar"
    http: HttpBase
    generation?: number
  } & (
    | // Regular desktop server
    { variant: "base" }
    // WSL server (windows only)
    | {
        variant: "wsl"
        distro: string
      }
  ) &
    Base

  // Remote server desktop can SSH into
  export type Ssh = {
    type: "ssh"
    host: string
    // SSH client exposes an HTTP server for the app to use as a proxy
    http: HttpBase
  } & Base

  export type Any =
    | Http
    // All these are desktop-only
    | (Sidecar | Ssh)

  export const key = (conn: Any): Key => {
    switch (conn.type) {
      case "http":
        return Key.make(conn.http.url)
      case "sidecar": {
        if (conn.variant === "wsl") return Key.make(`wsl:${conn.distro}`)
        const base = conn.http.url
        return Key.make(conn.generation ? `${base}#gen${conn.generation}` : base)
      }
      case "ssh":
        return Key.make(`ssh:${conn.host}`)
    }
  }

  export type Key = string & { _brand: "Key" }
  export const Key = { make: (v: string) => v as Key }
}

export const { use: useServer, provider: ServerProvider } = createSimpleContext({
  name: "Server",
  init: (props: { defaultServer: ServerConnection.Key; servers?: Array<ServerConnection.Any> }) => {
    const [store, setStore, _, ready] = persisted(
      Persist.global("server", ["server.v3"]),
      createStore({
        list: [] as StoredServer[],
        projects: {} as Record<string, StoredProject[]>,
        lastProject: {} as Record<string, string>,
        selected: undefined as ServerConnection.Key | undefined,
      }),
    )

    // Startup credential seed: servers injected through props that carry a
    // password (auth_token exchange, Desktop sidecar) persist through the
    // same store the "manage servers" dialog writes, so a page reload keeps
    // working after the URL token is cleared. Runs once when the store is
    // ready; a no-op seed returns the same array and skips the write.
    createEffect(() => {
      if (!ready()) return
      const seeded = seedStoredServers({ stored: store.list ?? [], props: props.servers })
      if (seeded !== (store.list ?? [])) setStore("list", seeded)
    })

    const url = (x: StoredServer) => (typeof x === "string" ? x : "type" in x ? x.http.url : x.url)

    const allServers = createMemo((): Array<ServerConnection.Any> => {
      return resolveServerList({ stored: store.list ?? [], props: props.servers })
    })

    const [state, setState] = createStore({
      active: props.defaultServer,
      initialized: false,
      restoringSavedSelection: false,
      // Bumped whenever saved credentials are rewritten in place. The app's
      // remount gate (ServerKey) folds this into its key, so saving a new
      // password rebuilds the provider tree — every store, SDK, and resource
      // re-creates against the fresh credentials without a page reload.
      credentialEpoch: 0,
    })

    createEffect(() => {
      if (!ready() || state.initialized) return
      const selection = resolveStartupServerSelection({
        fallback: props.defaultServer,
        saved: store.selected,
        servers: allServers(),
      })
      batch(() => {
        setState({
          active: selection.active,
          initialized: true,
          restoringSavedSelection: selection.restoringSavedSelection,
        })
        if (selection.persistFallback) setStore("selected", props.defaultServer)
      })
    })

    function setActive(input: ServerConnection.Key) {
      const active = normalizeServerSelection({ fallback: props.defaultServer, key: input, servers: allServers() })
      // A server (re)selection is a credential decision: the next 401 episode,
      // if any, must notify again instead of being swallowed by the old gate.
      authToastGate().reset()
      batch(() => {
        setState({ active, initialized: true, restoringSavedSelection: false })
        setStore("selected", active)
      })
    }

    function fallbackToDefault() {
      if (state.active === props.defaultServer && store.selected === props.defaultServer) return
      batch(() => {
        setState({ active: props.defaultServer, initialized: true, restoringSavedSelection: false })
        setStore("selected", props.defaultServer)
      })
    }

    function add(input: ServerConnection.Http) {
      const url_ = normalizeServerUrl(input.http.url)
      if (!url_) return
      const conn: ServerConnection.Http = { ...input, authToken: undefined, http: { ...input.http, url: url_ } }
      return batch(() => {
        const existing = store.list.findIndex((x) => url(x) === url_)
        const replaced = existing !== -1
        if (replaced) {
          setStore("list", existing, conn)
        } else {
          setStore("list", store.list.length, conn)
        }
        const active = normalizeServerSelection({
          fallback: props.defaultServer,
          key: ServerConnection.key(conn),
          servers: allServers(),
        })
        // Fresh credentials were just saved — re-arm the 401 toast gate, and
        // when the entry was rewritten in place (same URL key) bump the
        // credential epoch so the app remounts against the new credentials.
        authToastGate().reset()
        if (replaced) setState("credentialEpoch", (n) => n + 1)
        setState({ active, initialized: true, restoringSavedSelection: false })
        setStore("selected", active)
        return conn
      })
    }

    function remove(key: ServerConnection.Key) {
      const list = store.list.filter((x) => url(x) !== key)
      batch(() => {
        setStore("list", list)
        if (state.active === key || store.selected === key) {
          setState({ active: props.defaultServer, initialized: true, restoringSavedSelection: false })
          setStore("selected", props.defaultServer)
        }
      })
    }

    const isReady = createMemo(() => ready() && state.initialized && !!state.active)

    const origin = createMemo(() => projectsKey(state.active))
    const projectsList = createMemo(() => store.projects[origin()] ?? [])
    const current: Accessor<ServerConnection.Any | undefined> = createMemo(() => {
      const servers = allServers()
      return (
        servers.find((server) => ServerConnection.key(server) === state.active) ??
        (state.active === props.defaultServer
          ? servers.find((server) => server.type === "sidecar" && server.variant === "base")
          : undefined)
      )
    })
    const isLocal = createMemo(() => {
      const c = current()
      return (c?.type === "sidecar" && c.variant === "base") || (c?.type === "http" && isLocalHost(c.http.url))
    })

    return {
      ready: isReady,
      isLocal,
      get key() {
        return state.active
      },
      get credentialEpoch() {
        return state.credentialEpoch
      },
      get name() {
        return serverName(current())
      },
      get list() {
        return allServers()
      },
      get current() {
        return current()
      },
      restoringSavedSelection: () => state.restoringSavedSelection,
      setActive,
      fallbackToDefault,
      add,
      remove,
      projects: {
        list: projectsList,
        open(directory: string) {
          const key = origin()
          if (key === undefined || key === null) return
          const current = store.projects[key] ?? []
          if (current.find((x) => x.worktree === directory)) return
          setStore("projects", key, [{ worktree: directory, expanded: true }, ...current])
        },
        close(directory: string) {
          const key = origin()
          if (key === undefined || key === null) return
          const current = store.projects[key] ?? []
          setStore(
            "projects",
            key,
            current.filter((x) => x.worktree !== directory),
          )
        },
        expand(directory: string) {
          const key = origin()
          if (key === undefined || key === null) return
          const current = store.projects[key] ?? []
          const index = current.findIndex((x) => x.worktree === directory)
          if (index !== -1) setStore("projects", key, index, "expanded", true)
        },
        collapse(directory: string) {
          const key = origin()
          if (key === undefined || key === null) return
          const current = store.projects[key] ?? []
          const index = current.findIndex((x) => x.worktree === directory)
          if (index !== -1) setStore("projects", key, index, "expanded", false)
        },
        move(directory: string, toIndex: number) {
          const key = origin()
          if (key === undefined || key === null) return
          const current = store.projects[key] ?? []
          const fromIndex = current.findIndex((x) => x.worktree === directory)
          if (fromIndex === -1 || fromIndex === toIndex) return
          const result = [...current]
          const [item] = result.splice(fromIndex, 1)
          result.splice(toIndex, 0, item)
          setStore("projects", key, result)
        },
        last() {
          const key = origin()
          if (key === undefined || key === null) return
          return store.lastProject[key]
        },
        touch(directory: string) {
          const key = origin()
          if (key === undefined || key === null) return
          setStore("lastProject", key, directory)
        },
      },
    }
  },
})
