// lib/kernel/exception-center.ts
//
// THE EXCEPTION CENTER (cron_manager) — the Continuity Engine's component the
// notifications rail couldn't be: ONE place where everything the OS could NOT
// safely repair waits with its evidence (what broke, why the OS declined to
// fix it, what it already tried) and three human verbs — RETRY (re-run the
// scan/heal pass), RESOLVE (a human handled it), DISMISS (not an issue).
//
// APPEND-ONLY DISCIPLINE (agentic-os): an exception is never mutated closed —
// closure is a LATER ledger row (outcome 'resolved' / 'dismissed' / a
// successful 'healed' retry) on the same subject+flow. The fold below derives
// "open" from the record, so the ledger stays the single source of truth.
//
// THE RATCHET'S FEEDBACK LOOP: supervised (probation) repairs are listed with
// a "this fix was wrong" verb — which appends outcome 'failed' for that
// action, and because earned autonomy requires ZERO recorded failures, the
// repair type demotes to supervised INSTANTLY. The broker's supervision
// teaches the system; it doesn't just witness it.

import { FLOW_CONTRACTS } from "@/lib/kernel/self-heal-ledger"

export interface ExceptionLedgerRow {
  id: string
  subject: string
  action: string | null
  outcome: string
  detail: Record<string, any> | null
  createdAt: string
}

export interface OpenException {
  eventId: string
  flow: string
  subject: string
  /** plain-language what-this-is from the contract registry */
  describes: string
  /** why the OS escalated instead of fixing */
  reason: string
  at: string
}

export interface SupervisedRepair {
  eventId: string
  flow: string
  action: string
  subject: string
  describes: string
  at: string
}

export interface ExceptionCenterRead {
  open: OpenException[]
  supervised: SupervisedRepair[]
}

const CLOSERS = new Set(["resolved", "dismissed", "healed"])

function keyOf(row: ExceptionLedgerRow): string {
  return `${row.detail?.flow ?? row.action ?? "unknown"}:${row.subject}`
}

/**
 * PURE: fold the ledger (ascending or unsorted) into the center's two lists.
 * • OPEN = an 'escalated' row with NO LATER closer (resolved/dismissed/healed)
 *   on the same flow+subject. A later failed retry does NOT close it.
 * • SUPERVISED = recent probation-tier 'healed' rows a human may still veto —
 *   excluded once flagged wrong (a later human_flagged 'failed' row exists).
 */
export function composeExceptionCenter(rows: ExceptionLedgerRow[], opts?: { maxOpen?: number; maxSupervised?: number }): ExceptionCenterRead {
  const sorted = [...rows].sort((a, b) => a.createdAt.localeCompare(b.createdAt))

  const open = new Map<string, OpenException>()
  const supervised = new Map<string, SupervisedRepair>()

  for (const row of sorted) {
    const key = keyOf(row)
    const flow = String(row.detail?.flow ?? row.action ?? "unknown")
    const contract = FLOW_CONTRACTS[flow]

    if (row.outcome === "escalated") {
      open.set(key, {
        eventId: row.id,
        flow,
        subject: row.subject,
        describes: contract?.describes ?? flow.replace(/_/g, " "),
        reason: String(row.detail?.reason ?? contract?.reason ?? "The OS declined to repair this automatically."),
        at: row.createdAt,
      })
      continue
    }
    if (CLOSERS.has(row.outcome)) {
      open.delete(key) // a later closer ends the exception — append-only closure
    }
    if (row.outcome === "healed" && contract?.tier === "probation" && row.action) {
      supervised.set(key, {
        eventId: row.id,
        flow,
        action: row.action,
        subject: row.subject,
        describes: contract.describes,
        at: row.createdAt,
      })
    }
    if (row.outcome === "failed" && row.detail?.human_flagged) {
      supervised.delete(key) // already vetoed — nothing left to flag
    }
  }

  const openList = [...open.values()].sort((a, b) => b.at.localeCompare(a.at)).slice(0, opts?.maxOpen ?? 20)
  const supervisedList = [...supervised.values()].sort((a, b) => b.at.localeCompare(a.at)).slice(0, opts?.maxSupervised ?? 10)
  return { open: openList, supervised: supervisedList }
}
