// lib/vendor-governance/paid-egress.ts — THE PAID EGRESS DOOR (wave 156, lane 156S).
//
// A module of its own ON PURPOSE: lib/vendor-governance/budget-gate.ts is on the proxy's read path (the paywall), and this
// composition reaches the action ledger — an edge the proxy compile must never carry (scripts/proxy-graph-budget-guard.ts).
// budget-gate.ts keeps exactly what it imported before; this file imports the budget, the ledger and the meter.

import "server-only"
import { checkVendorBudget, type VendorBudgetResult } from "./budget-gate"
//
// Every paid render / video / voice / image call used to assemble the same three steps by hand — and each door kept a
// different subset of them. lib/did/index.ts generateVideo and lib/voice/elevenlabs-tts.ts synthesizeSpeech checked this
// budget and metered the spend, but ONLY when the caller passed a tenant (a tenant-less call was neither gated nor booked),
// with no idempotency key on the booking and no action receipt; lib/ai/image-generation.ts generateImage booked the spend but
// never asked the budget at all. This is the ONE composition of the existing survivors — no new ledger, no new budget:
//
//   1. THE BUDGET, BEFORE THE CALL — checkVendorBudget above (the brokerage's plan-tier ceiling, `addCost` = this call's
//      estimate). Over budget → the provider is NEVER reached, and the refusal is a receipt, not a silence.
//   2. THE RECEIPT — lib/kernel/action-ledger.ts withActionLedger: tenant, action, subject, actor, idempotency key; settled
//      `executed` (with the provider, its job id and the cost), `failed` (cost 0), or `skipped` (budget_refused, cost 0).
//      A retry under the same key REPLAYS the receipt and never calls the provider a second time.
//   3. THE SPEND, ONLY ON SUCCESS — meterVendorSpend (vendor_usage_tracking, the ledger THIS budget sums), once, under the
//      same idempotency key. A failed call books nothing. A door whose spend lives on another ledger (an image model books
//      ai_tool_usage through lib/ai/cost-tracking.ts) passes `book: "caller"` and keeps booking there itself.
//
// NO TENANT = PLATFORM SPEND. A call with no brokerage cannot be measured against a tenant ceiling and cannot carry a tenant
// receipt (agent_action_ledger.brokerage_id); it is booked `platformPaid` (m750) instead of vanishing from the ledger.
// The budget's own fail-open contract (above) is unchanged: an unreadable ledger lets the call through, `degraded` set.

export interface PaidEgressDoor {
  /** The VERIFIED tenant (session / the row being worked). null = platform-paid spend (no ceiling, no tenant receipt). */
  brokerageId: string | null
  /** vendor_usage_tracking.vendor_name — the ONE spelling the meter already uses for this vendor. */
  vendor: string
  usageType: string
  /** agent_action_ledger.action — `domain.entity.action`. */
  action: string
  /** USD this call is expected to cost — the budget pre-flight's `addCost` and the booking when `judge` names no price. */
  estimatedCostUsd: number
  units?: number
  subject?: { type: string; id?: string | null; ref?: string | null }
  actor?: { type: "user" | "agent" | "manager" | "system"; userId?: string | null; agentId?: string | null; managerKey?: string | null }
  /** ONE charge per key: a retry under it replays the receipt and never reaches the provider. */
  idempotencyKey?: string | null
  reasonCode?: string | null
  systemSource?: string
  /** "vendor" (default): book on vendor_usage_tracking on success. "caller": the door books on its own ledger. */
  book?: "vendor" | "caller"
  metadata?: Record<string, unknown>
}

export interface PaidEgressJudgement {
  ok: boolean
  /** The price of THIS call when the door knows it better than the estimate (characters actually billed, …). */
  costUsd?: number
  units?: number
  providerRef?: string | null
  error?: string | null
}

export type PaidEgressResult<T> =
  | { ran: true; result: T; ok: boolean; costUsd: number; booked: boolean }
  | { ran: false; reason: "budget_refused"; detail: string; budget: VendorBudgetResult }
  | { ran: false; reason: "replay" | "in_flight" | "ledger_refused"; detail: string; providerRef: string | null }

/** Spend for a call that RAN: the door's own price when it named one, else the estimate; never for a failed call. */
export function paidEgressCost(door: Pick<PaidEgressDoor, "estimatedCostUsd">, j: PaidEgressJudgement): number {
  if (!j.ok) return 0
  const c = typeof j.costUsd === "number" && Number.isFinite(j.costUsd) ? j.costUsd : door.estimatedCostUsd
  return c > 0 ? c : 0
}

/**
 * Budget → receipt → call → spend-on-success, for ONE paid provider call. Never calls the provider over budget, never books
 * a failure, never calls twice under one idempotency key. A thrown `call` is settled `failed` (or `unknown` on a timeout) by
 * the ledger and rethrown to the door's own catch — nothing is booked.
 */
export async function runPaidEgress<T>(
  door: PaidEgressDoor,
  call: () => Promise<T>,
  judge: (result: T) => PaidEgressJudgement,
): Promise<PaidEgressResult<T>> {
  const { meterVendorSpend } = await import("./meter-vendor")
  const key = door.idempotencyKey && door.idempotencyKey.trim() ? door.idempotencyKey.trim() : null
  const book = async (j: PaidEgressJudgement, cost: number): Promise<boolean> => {
    if (!j.ok || door.book === "caller" || cost <= 0) return false
    return meterVendorSpend({
      vendorName: door.vendor, usageType: door.usageType, cost, unitCount: j.units ?? door.units ?? 1,
      brokerageId: door.brokerageId, platformPaid: !door.brokerageId, idempotencyKey: key,
      systemSource: door.systemSource ?? door.usageType,
      metadata: { ...(door.metadata ?? {}), action: door.action, ...(j.providerRef ? { provider_ref: j.providerRef } : {}) },
    })
  }

  if (!door.brokerageId) {
    const result = await call()
    const j = judge(result)
    const cost = paidEgressCost(door, j)
    return { ran: true, result, ok: j.ok, costUsd: cost, booked: await book(j, cost) }
  }
  const brokerageId = door.brokerageId

  type Ran = { kind: "refused"; budget: VendorBudgetResult } | { kind: "ran"; result: T; j: PaidEgressJudgement; cost: number; booked: boolean }
  type Out = Ran | { kind: "replay"; claim: { kind: string; entry?: { provider_ref?: string | null } | null; error?: string } }
  const { withActionLedger } = await import("@/lib/kernel/action-ledger")
  const out = await withActionLedger<Out>(
    {
      brokerageId, action: door.action,
      actor: door.actor ?? { type: "system" },
      subject: door.subject ?? { type: door.vendor, id: null },
      idempotencyKey: key, reasonCode: door.reasonCode ?? null,
      systemSource: door.systemSource ?? door.usageType, channel: null,
      detail: { vendor: door.vendor, usage_type: door.usageType, estimated_cost_usd: door.estimatedCostUsd, ...(door.metadata ?? {}) },
    },
    async (): Promise<Out> => {
      const budget = await checkVendorBudget({ brokerageId, addCost: door.estimatedCostUsd })
      if (!budget.allowed) return { kind: "refused", budget }
      const result = await call()
      const j = judge(result)
      const cost = paidEgressCost(door, j)
      return { kind: "ran", result, j, cost, booked: await book(j, cost) }
    },
    {
      settle: (o) => o.kind === "refused"
        ? { status: "skipped", outcome: "budget_refused", provider: door.vendor, costUsd: 0, error: `over the plan-tier vendor ceiling ($${o.budget.spent} of $${o.budget.budget})` }
        : o.kind === "ran" && o.j.ok
          ? { status: "executed", outcome: "succeeded", provider: door.vendor, providerRef: o.j.providerRef ?? null, costUsd: o.cost }
          : { status: "failed", outcome: "provider_failed", provider: door.vendor, costUsd: 0, error: o.kind === "ran" ? (o.j.error ?? "provider call failed") : null },
      replay: (claim) => ({ kind: "replay", claim: claim as never }),
    },
  )
  if (out.kind === "refused") {
    return { ran: false, reason: "budget_refused", detail: `vendor budget exceeded — ${door.vendor} ${door.usageType} paused ($${out.budget.spent}/$${out.budget.budget})`, budget: out.budget }
  }
  if (out.kind === "replay") {
    const c = out.claim
    const reason = c.kind === "replay" ? "replay" : c.kind === "refused" ? "ledger_refused" : "in_flight"
    return { ran: false, reason, detail: c.error ?? `${door.action} already ${c.kind === "replay" ? "ran" : "in flight"} under ${key}`, providerRef: c.entry?.provider_ref ?? null }
  }
  return { ran: true, result: out.result, ok: out.j.ok, costUsd: out.cost, booked: out.booked }
}
