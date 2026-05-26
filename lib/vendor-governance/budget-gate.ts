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
      .select("vendor_name, estimated_cost")
      .eq("brokerage_id", brokerageId)
      .gte("created_at", startOfMonthIso())
    const byVendor = new Map<string, number>()
    for (const r of (data ?? []) as any[]) {
      byVendor.set(r.vendor_name, (byVendor.get(r.vendor_name) ?? 0) + (Number(r.estimated_cost) || 0))
    }
    return [...byVendor.entries()]
      .map(([vendor, spent]) => ({ vendor, spent: Math.round(spent * 100) / 100 }))
      .sort((a, b) => b.spent - a.spent)
  } catch {
    return []
  }
}
