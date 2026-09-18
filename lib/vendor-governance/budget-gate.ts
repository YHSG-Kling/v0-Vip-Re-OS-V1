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
      .select("total_cost")
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

    const spent = (rows ?? []).reduce((s, r: any) => s + (Number(r.total_cost) || 0), 0)
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
