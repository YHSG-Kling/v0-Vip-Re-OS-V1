/**
 * lib/events/dispatcher-registry.ts — the ONE orchestrator-dispatcher slot.
 *
 * Moved out of lib/events/event-helpers.ts (lane 86F) so the server-only
 * lifecycle-event core (lib/events/lifecycle-event-core.ts) can reach the
 * registered dispatcher without importing a module that builds the cookie
 * client. lib/orchestrator/internal.ts registers orchestrateEvent here when it
 * loads; event-helpers re-exports registerEventDispatcher unchanged.
 *
 * Plain module (no server-only): it holds a function reference and nothing else.
 */
import type { Event } from "./types"

export type EventDispatcher = (event: Event) => Promise<void>

let dispatcher: EventDispatcher | null = null

export function registerEventDispatcher(fn: EventDispatcher): void {
  dispatcher = fn
}

export function getRegisteredEventDispatcher(): EventDispatcher | null {
  return dispatcher
}
