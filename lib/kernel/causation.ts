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
  correlationId: string | null; /** WAVE 156 (156M): what the work under this scope RESTS ON, stated once by the shared boundary that opened it (see the foot). */ originTrust?: OriginTrust | null
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
  return store.run({ causationId: eventId, correlationId: parent.correlationId ?? eventId, originTrust: parent.originTrust ?? null }, fn)
}

// ─── WAVE 156 (lane 156M, round 2) — THE ORIGIN TRUST A SHARED BOUNDARY STATES ONCE ──────────────────────────────────────────
// An autonomous ledger row (actor manager / system) that states no trust class used to read `trust_class: null` — a named gap on 73
// call sites. Most of them run under ONE of two shared boundaries, and each boundary knows what the work rests on:
//   · the kernel event processor (lib/kernel/notification-engine.ts processKernelEvent) — a reaction to a RECORDED platform event:
//     `verified_first_party`;
//   · a cron run that passed lib/cron-auth.ts verifyCronAuth — the platform scheduler running the tenant's configured automation:
//     `tenant_policy`.
// The boundary states it HERE once; the action ledger (lib/kernel/action-ledger.ts insertLedgerRow) fills ONLY a missing trust class on
// an autonomous row from it, and records the source (`trust_source: boundary:<name>`). A stated class always wins; a person acting keeps
// `authorized_human`. The vocabulary is DECISION_TRUST_CLASSES (lib/kernel/action-ledger.ts) — no new spelling.

export interface OriginTrust { trustClass: "verified_first_party" | "tenant_policy"; boundary: "kernel_event_processor" | "cron_scheduler" }

/** Run `fn` with the origin trust a shared boundary states (the causation ids are inherited unchanged). */
export function withOriginTrust<T>(trustClass: OriginTrust["trustClass"], boundary: OriginTrust["boundary"], fn: () => Promise<T>): Promise<T> {
  const parent = currentCausation()
  return store.run({ causationId: parent.causationId, correlationId: parent.correlationId, originTrust: { trustClass, boundary } }, fn)
}

/** The same, for a SYNCHRONOUS boundary (a route's auth check): the rest of the caller's async work runs under it. */
export function enterOriginTrust(trustClass: OriginTrust["trustClass"], boundary: OriginTrust["boundary"]): void {
  const parent = currentCausation()
  store.enterWith({ causationId: parent.causationId, correlationId: parent.correlationId, originTrust: { trustClass, boundary } })
}
