// lib/vendor-governance/budget-gate.ts
// Brokerage-level VENDOR-SPEND budget gate. Closes the governance loop:
//   subscription kill-switch  →  per-call metering (meter-vendor.ts)  →  THIS cap.
//
// Sums the current calendar month's spend from vendor_usage_tracking (the unified
// ledger every data + AI vendor records to) and compares it to the brokerage's
// plan-tier monthly ceiling. Platform-controlled AI vendors (D-ID, HeyGen,
// ElevenLabs, Vapi) call checkVendorBudget() BEFORE incurring spend so an
// over-budget brokerage auto-pauses instead of running up the platform's bill.
//
// Fail-open: a budget read error never blocks a customer flow (advisory cap).

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { evaluateVendorBudget, vendorBudgetForTier, MONTHLY_VENDOR_BUDGET_USD, type VendorBudgetEval } from "./budget-eval"

export { evaluateVendorBudget, vendorBudgetForTier, MONTHLY_VENDOR_BUDGET_USD }

export interface VendorBudgetResult extends VendorBudgetEval {
  planTier: string
}

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
  const supabase = createServiceClient()

  const { data: brokerage } = await supabase
    .from("brokerages")
    .select("plan_tier")
    .eq("id", params.brokerageId)
    .maybeSingle()
  const planTier = brokerage?.plan_tier ?? "solo_agent"
  const budget = vendorBudgetForTier(planTier)

  const { data: rows, error } = await supabase
    .from("vendor_usage_tracking")
    .select("estimated_cost")
    .eq("brokerage_id", params.brokerageId)
    .gte("created_at", startOfMonthIso())

  if (error) {
    // Fail open — a ledger read error must never take a customer flow down.
    return { allowed: true, spent: 0, budget, percent: 0, softWarning: false, planTier }
  }

  const spent = (rows ?? []).reduce((s, r: any) => s + (Number(r.estimated_cost) || 0), 0)
  return { ...evaluateVendorBudget(spent, budget, params.addCost ?? 0), planTier }
}
