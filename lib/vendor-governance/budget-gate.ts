// lib/vendor-governance/budget-gate.ts
// Brokerage-level VENDOR-SPEND budget gate. Closes the governance loop:
//   subscription kill-switch  →  per-call metering (meter-vendor.ts)  →  THIS cap.
//
// Sums the current calendar month's spend from vendor_usage_tracking (the unified
// ledger every data + AI vendor records to) and compares it to the brokerage's
// plan-tier monthly ceiling. Platform-controlled AI vendors (D-ID, HeyGen,
// ElevenLabs, Vapi) call checkVendorBudget() BEFORE incurring spend so an
// over-budget brokerage auto-pauses instead of running up the platform's bill.
// The egress gate (lib/providers/dispatch.ts) pre-flights the SAME check for
// SendGrid email, Twilio SMS/voice, and Lob mail; the Twilio-native AI call lane
// (lib/voice/twilio-outbound.ts) pre-flights it for outbound voice dials.
//
// Fail-open: a budget read error never blocks a customer flow (advisory cap).
//
// ── WHY THE TIER READ DESTRUCTURES `error` (wave 19) ─────────────────────────
// checkVendorBudget performs TWO reads. The ledger read always honoured the
// fail-open contract below; the plan-tier read did not. It was written
//
//     const { data: brokerage } = await supabase
//     const planTier = brokerage?.plan_tier ?? "solo_agent"
//
// and supabase-js RESOLVES a refused query rather than throwing, so a REFUSED
// tier read arrived as `data: null` and silently became the most restrictive
// tier on the platform. An enterprise tenant could then be measured against a
// $50 ceiling that is not its ceiling and told it was over budget — a verdict
// that looks measured and is not. Both reads now report their degradation the
// same way. This did NOT invert the fail-open contract: an unreadable ledger
// still returns allowed:true, and the tier branch does the same.
//
// ── WHY TWO DEGRADATION FLAGS AND NOT ONE ────────────────────────────────────
// "We do not know how much was SPENT" and "we do not know what the CEILING is"
// are different unknowns with different consequences, and one boolean cannot
// carry both — provably, because of the third case: a tenant record that is
// genuinely ABSENT (maybeSingle returns null with NO error) is not a refusal.
// There the verdict is fully measurable and may legitimately refuse, so the
// fail-open flag must stay OFF — yet the ceiling it refused against was still
// ASSUMED rather than read, and a caller that has to say "you are over budget"
// out loud needs to know that. `degraded` keeps its original meaning (this
// verdict is fail-open, do not trust it); `degradedTier` / `degradedSpend` name
// WHICH half was not readable, so a surface can explain itself honestly.

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { evaluateVendorBudget, vendorBudgetForTier, MONTHLY_VENDOR_BUDGET_USD, DEFAULT_VENDOR_BUDGET, type VendorBudgetEval, type VendorBudgetDegradation } from "./budget-eval"

export { evaluateVendorBudget, vendorBudgetForTier, MONTHLY_VENDOR_BUDGET_USD }

/**
 * The three degradation flags live on `VendorBudgetDegradation` in the PURE
 * module (budget-eval.ts), documented field by field there. They were declared
 * here in wave 19 and moved in wave 21 for one reason: `redactBudgetForActor` —
 * the only surface that renders these verdicts to a human — is pure and I/O-free
 * by contract and cannot import a `server-only` module, so it would have needed
 * a second hand-copied declaration of the same three fields. One definition,
 * extended here, is how the views cannot fall behind the gate.
 */
export interface VendorBudgetResult extends VendorBudgetEval, VendorBudgetDegradation {
  planTier: string
}

/**
 * The tier assumed when the tenant's own plan tier could not be read.
 *
 * Deliberately the MOST RESTRICTIVE tier, kept as-is from before this wave. It
 * is the right assumption for the money — the ceilings guard the PLATFORM's
 * vendor bill, and quietly assuming a large ceiling for a tenant whose tier we
 * could not read is how an unreadable record becomes an uncapped one. The known
 * objection is that it is also the assumption most likely to produce a false
 * "over budget" for a large customer; that harm is removed by construction
 * rather than by raising the assumption, because every path that assumes a tier
 * either returns allowed:true (a refused read fails open, exactly as a refused
 * ledger read does) or sets `degradedTier` so no caller can present the ceiling
 * as measured. Raising the assumed ceiling instead would have traded a false
 * refusal for silent unbounded spend on an unreadable record.
 */
const ASSUMED_TIER_ON_UNREADABLE = "solo_agent"

/** First day of the current calendar month at 00:00 UTC (ISO). */
function startOfMonthIso(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString()
}

/**
 * Check a brokerage's month-to-date vendor spend against its plan-tier ceiling.
 * `addCost` lets callers pre-flight ("if this $0.50 render goes through, are we
 * over?"). Never throws — returns allowed:true on any read error (advisory cap).
 */
export async function checkVendorBudget(params: {
  brokerageId: string
  addCost?: number
}): Promise<VendorBudgetResult> {
  try {
    const supabase = createServiceClient()

    const { data: brokerage, error: tierError } = await supabase
      .from("brokerages")
      .select("plan_tier")
      .eq("id", params.brokerageId)
      .maybeSingle()

    if (tierError) {
      // Fail open — the SAME contract the ledger branch below has always held,
      // now applied to the read that used to drop its error. We never learned
      // the ceiling, so we cannot honestly measure anything against it: no
      // verdict is computed and none is implied. Both halves are unknown here —
      // the ledger was never reached.
      return {
        allowed: true, spent: 0, budget: DEFAULT_VENDOR_BUDGET, percent: 0, softWarning: false,
        planTier: ASSUMED_TIER_ON_UNREADABLE, degraded: true, degradedTier: true, degradedSpend: true,
      }
    }

    // An ABSENT record is not a refusal. maybeSingle resolves `null` with no
    // error when no row matches, and that answer is trustworthy: the verdict
    // below is fully measured and may legitimately refuse. What it is NOT is
    // measured against this tenant's own ceiling — so `degraded` stays off and
    // `degradedTier` carries the assumption on its own. This is the case a
    // single boolean cannot describe.
    const tierAssumed = !brokerage?.plan_tier
    const planTier = brokerage?.plan_tier ?? ASSUMED_TIER_ON_UNREADABLE
    const budget = vendorBudgetForTier(planTier)

    const { data: rows, error } = await supabase
      .from("vendor_usage_tracking")
      .select("total_cost, request_metadata")
      .eq("brokerage_id", params.brokerageId)
      .gte("created_at", startOfMonthIso())

    if (error) {
      // Fail open — a ledger read error must never take a customer flow down.
      // `degraded` tells egress pre-flights this verdict is fail-open so they can
      // ledger the breakage (and still send). The ceiling here IS real (it was
      // read above), so only the spend half is degraded.
      return {
        allowed: true, spent: 0, budget, percent: 0, softWarning: false, planTier,
        degraded: true, degradedTier: tierAssumed, degradedSpend: true,
      }
    }

    // Owner (wave 139): platform-covered operational spend (scraping, behaviour monitoring, brand listening,
    // research) is part of the SaaS — attributed to the tenant on the ledger but never the tenant's cost, so
    // it never consumes the tenant's ceiling (a platform scrape must not pause the tenant's own sends).
    const spent = (rows ?? []).reduce((s, r: any) => s + (r?.request_metadata?.platform_paid === true ? 0 : (Number(r.total_cost) || 0)), 0)
    return { ...evaluateVendorBudget(spent, budget, params.addCost ?? 0), planTier, degradedTier: tierAssumed }
  } catch {
    // Same fail-open contract for a thrown failure (client construction, network).
    return {
      allowed: true, spent: 0, budget: DEFAULT_VENDOR_BUDGET, percent: 0, softWarning: false,
      planTier: ASSUMED_TIER_ON_UNREADABLE, degraded: true, degradedTier: true, degradedSpend: true,
    }
  }
}

/**
 * Trailing-window count of outbound sends the budget gate REFUSED for a brokerage —
 * derived from the existing refusal ledger (self_heal_events rows the egress
 * pre-flight in lib/providers/dispatch.ts appends with detail.flow
 * 'egress_budget_blocked'). Cheap head-count, no new tables. Returns 0 on any read
 * error — the surface simply omits the line rather than fabricating a number.
 */
export async function getBudgetBlockedSendCount(brokerageId: string, days = 30): Promise<number> {
  try {
    const supabase = createServiceClient()
    const since = new Date(Date.now() - days * 86_400_000).toISOString()
    const { count, error } = await supabase
      .from("self_heal_events")
      .select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId)
      .eq("outcome", "escalated")
      .eq("detail->>flow", "egress_budget_blocked")
      .gte("created_at", since)
    if (error) return 0
    return count ?? 0
  } catch {
    return 0
  }
}

/**
 * Superadmin-controlled toggle: may brokerage/subscriber users see the
 * "approaching usage limit" warning at all? (Vendor names + dollar amounts are
 * NEVER shown to brokerages regardless of this flag.) Defaults to true (show) on
 * any read error — a missing-row failure should not silently hide a real warning.
 */
export async function getBrokerageBudgetWarningEnabled(): Promise<boolean> {
  try {
    const supabase = createServiceClient()
    const { data, error } = await supabase
      .from("platform_settings")
      .select("show_brokerage_budget_warning")
      .eq("id", true)
      .single()
    if (error || !data) return true
    return data.show_brokerage_budget_warning !== false
  } catch {
    return true
  }
}

/**
 * Per-vendor month-to-date spend breakdown for a brokerage. PLATFORM-STAFF ONLY —
 * callers must gate on isPlatformStaff before exposing this (it contains vendor names).
 */
export async function getVendorSpendBreakdown(brokerageId: string): Promise<Array<{ vendor: string; spent: number }>> {
  try {
    const supabase = createServiceClient()
    const { data } = await supabase
      .from("vendor_usage_tracking")
      .select("vendor_name, total_cost")
      .eq("brokerage_id", brokerageId)
      .gte("created_at", startOfMonthIso())
    const byVendor = new Map<string, number>()
    for (const r of (data ?? []) as any[]) {
      byVendor.set(r.vendor_name, (byVendor.get(r.vendor_name) ?? 0) + (Number(r.total_cost) || 0))
    }
    return [...byVendor.entries()]
      .map(([vendor, spent]) => ({ vendor, spent: Math.round(spent * 100) / 100 }))
      .sort((a, b) => b.spent - a.spent)
  } catch {
    return []
  }
}

// ─── THE PAID EGRESS DOOR (wave 156, lane 156S) ─────────────────────────────────────────────────────────────────────────
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
