// lib/outcomes/send-intent-scope.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE AMBIENT SEND INTENT (wave 153, lane 153S — owner ruling B10: "crash mid-send is marked 'outcome unknown' and need to
// be re-sent automatically"). A caller whose unit of ONCE is not visible to the dispatcher — a bundle follow-on goes through a
// channel orchestrator that takes no ledger argument — wraps its send in withSendIntent; lib/providers/dispatch.ts then keys
// the send's agent_action_ledger row (and the provider's own Idempotency-Key, where one exists) on it. A re-run of the SAME
// intent after a crash therefore meets the SAME ledger row: executed → replayed (no second send), unknown / in flight → refused
// until lib/outcomes/reconciliation-ledger.ts recoverOutcomeUnknownSends has reconciled it.
//
// A LEAF ON PURPOSE: only node:async_hooks. dispatch.ts sits in the heaviest app graphs (test:proxy-graph-budget), and a test
// harness that stubs the channel orchestrators must be able to import this without loading the dispatcher.

import { AsyncLocalStorage } from "node:async_hooks"

export interface SendIntentScope {
  /** The caller's stable unit of once (e.g. `bundle_follow_on:<dispatch>:<item>`). The dispatcher appends the action. */
  key: string
}

const store = new AsyncLocalStorage<SendIntentScope>()

/** Run `fn` with every governed send inside it keyed on `key` (+ the dispatcher's action). */
export function withSendIntent<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const k = String(key ?? "").trim()
  if (!k) return fn()
  return store.run({ key: k }, fn)
}

/** The ledger's refusal words for a re-run of an intent whose earlier attempt is unresolved (lib/kernel/action-ledger.ts
 *  replayDispatchResult: kind 'unknown' / 'in_flight'). scripts/send-recovery-guard.ts holds this against the real strings. */
const PENDING_RECOVERY = /outcome is unknown|already in flight/i

/** The error text of a send the LEDGER declined because the same intent is unresolved — neither a send nor a failure. */
export function isOutcomePendingRecoveryError(error: string | null | undefined): boolean {
  return PENDING_RECOVERY.test(error ?? "")
}

/** A dispatch result the ledger declined pending recovery (providerKey `action_ledger_gate`). */
export function isOutcomePendingRecovery(r: { success?: boolean; providerKey?: string; error?: string } | null | undefined): boolean {
  return !!r && r.success !== true && r.providerKey === "action_ledger_gate" && isOutcomePendingRecoveryError(r.error)
}

/** The ambient intent key for `action`, or null outside a scope. */
export function ambientSendIntentKey(action: string): string | null {
  const s = store.getStore()
  return s?.key ? `${s.key}:${action}` : null
}
