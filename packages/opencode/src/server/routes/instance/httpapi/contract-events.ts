import { BusEvent } from "@/bus/bus-event"
import { Event as InstallationEvent } from "@/installation"
import { Pty } from "@/pty"
import { Event as MessageEvent } from "@/session/message-v2"
import { Event as SessionEvent } from "@/session/session"
import { SyncEvent } from "@/sync"

// Loading these definitions is contract assembly only. Runtime projector
// initialization stays in server/init-projectors; no database, listener, Home,
// or network service is started here.
void InstallationEvent
void Pty.Event
void MessageEvent
void SessionEvent

const latest = new Map<string, SyncEvent.Definition>()
for (const definition of SyncEvent.registry.values()) {
  const current = latest.get(definition.type)
  if (!current || definition.version > current.version) latest.set(definition.type, definition)
}
for (const definition of latest.values()) BusEvent.define(definition.type, definition.properties)
