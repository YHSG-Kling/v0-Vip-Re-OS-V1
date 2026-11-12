/**
 * CAUSATION SCOPE — "which event made this happen?" carried through async work (wave 97, lane 97A).
 *
 * The kernel processes an event (lib/kernel/notification-engine.ts processKernelEvent) and its
 * reactors emit child events and send email/SMS/mail several async hops later. Threading a
 * `causationId` parameter through every reactor and every send helper would touch hundreds of
 * callers; the blueprint's rule is to wire the CHOKEPOINTS. So the processor opens a scope here
 * (the event it is processing becomes the cause), and the two chokepoints that record things —
 * emitKernelEvent (lib/kernel/emit.ts) for child events, and the action ledger
 * (lib/kernel/action-ledger.ts) for external actions — READ the scope. A caller that has the
 * parent in hand may still pass it explicitly; explicit always wins.
 *
 *   causationId   — the immediate parent (a lifecycle_events.id).
 *   correlationId — the ROOT of the chain: inherited unchanged by every descendant, so one
 *                   query on it returns the whole cascade an original event set off.
 *
 * Outside any scope both are null — an event raised by a human click has no cause but the human.
 */
// No `import "server-only"` marker on purpose: lib/providers/dispatch.ts and the kernel processor
// import this, and plain-tsx proofs (no react-server condition) load the dispatcher for real —
// the marker would throw there. node:async_hooks already cannot enter a browser bundle.
import { AsyncLocalStorage } from "node:async_hooks"

export interface CausationScope {
  causationId: string | null
  correlationId: string | null
}

const store = new AsyncLocalStorage<CausationScope>()

/** The scope the current async work runs under, or nulls outside any. */
export function currentCausation(): CausationScope {
  return store.getStore() ?? { causationId: null, correlationId: null }
}

/**
 * Run `fn` with `eventId` as the cause of everything it does. The correlation (chain root) is
 * inherited from the enclosing scope, or — at the root — is the event itself.
 */
export function withCausationFrom<T>(eventId: string | null | undefined, fn: () => Promise<T>): Promise<T> {
  if (!eventId) return fn()
  const parent = currentCausation()
  return store.run({ causationId: eventId, correlationId: parent.correlationId ?? eventId }, fn)
}
