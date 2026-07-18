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

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { evaluateVendorBudget, vendorBudgetForTier, MONTHLY_VENDOR_BUDGET_USD, DEFAULT_VENDOR_BUDGET, type VendorBudgetEval } from "./budget-eval"

export { evaluateVendorBudget, vendorBudgetForTier, MONTHLY_VENDOR_BUDGET_USD }

export interface VendorBudgetResult extends VendorBudgetEval {
  planTier: string
  /**
   * True when the budget could NOT actually be read (ledger/table read failure) and
   * `allowed: true` is a FAIL-OPEN verdict, not a real one. Callers that pre-flight
   * sends may ledger the breakage (recordSelfHeal) but MUST still proceed — a broken
   * budget system never silences a consented client communication.
   */
  degraded?: boolean
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
  try {
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
      .select("total_cost")
      .eq("brokerage_id", params.brokerageId)
      .gte("created_at", startOfMonthIso())

    if (error) {
      // Fail open — a ledger read error must never take a customer flow down.
      // `degraded` tells egress pre-flights this verdict is fail-open so they can
      // ledger the breakage (and still send).
      return { allowed: true, spent: 0, budget, percent: 0, softWarning: false, planTier, degraded: true }
    }

    const spent = (rows ?? []).reduce((s, r: any) => s + (Number(r.total_cost) || 0), 0)
    return { ...evaluateVendorBudget(spent, budget, params.addCost ?? 0), planTier }
  } catch {
    // Same fail-open contract for a thrown failure (client construction, network).
    return { allowed: true, spent: 0, budget: DEFAULT_VENDOR_BUDGET, percent: 0, softWarning: false, planTier: "solo_agent", degraded: true }
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
