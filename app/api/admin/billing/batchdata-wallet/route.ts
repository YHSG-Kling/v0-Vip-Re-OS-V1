// app/api/admin/billing/batchdata-wallet/route.ts
//
// Platform billing diagnostics: BatchData's OWN live wallet balance beside this month's
// vendor_usage_tracking estimate for vendor 'batchdata' (wave 69 orphan-export wire-up —
// lib/external/batchdata-client.ts::fetchBatchDataWalletBalance had no reader anywhere;
// lib/kernel/manager-registry.ts's `batchdata_wallet_reconcile` domain already writes the
// DRIFT report via reconcileBatchDataWalletSpend/fetchBatchDataWalletConsumptionReport, but
// nothing ever showed a HUMAN the live balance itself). Account-wide, not per-brokerage —
// BatchData's wallet is ONE platform account balance (CLAUDE.md §5: platform pays the
// provider), so unlike the live-agent-sessions drill-down this route takes no brokerageId.
// Gate first (requireSuperadminAuth — platform staff only, this is platform spend), then the
// provider read. Caller: BillingDiagnosticsPanel.

import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { requireSuperadminAuth } from "@/lib/kernel/api-auth"
import { fetchBatchDataWalletBalance } from "@/lib/external/batchdata-client"

export async function GET() {
  const supabase = await createClient()
  const auth = await requireSuperadminAuth(supabase)
  if (!auth.ok) return auth.response

  try {
    const wallet = await fetchBatchDataWalletBalance()

    // This month's OWN vendor_usage_tracking estimate for vendor 'batchdata' — the SAME sum
    // the wallet-reconcile cron computes (app/api/cron/lead-scraping/route.ts), read again
    // here purely for display so a superadmin sees balance + spend-so-far side by side
    // without waiting for the next cron tick's automation_errors row.
    const svc = createServiceClient()
    const startOfMonth = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString()
    const { data: spendRows, error: spendError } = await svc
      .from("vendor_usage_tracking")
      .select("total_cost")
      .eq("vendor_name", "batchdata")
      .gte("created_at", startOfMonth)
    if (spendError) {
      console.error("[API] /admin/billing/batchdata-wallet vendor_usage_tracking read failed:", spendError.message)
    }
    const estimatedSpendThisMonthUsd = (spendRows ?? []).reduce(
      (s: number, r: { total_cost: number | null }) => s + (Number(r.total_cost) || 0), 0,
    )

    return NextResponse.json({
      success: wallet.ok,
      balanceUsd: wallet.balanceUsd,
      estimatedSpendThisMonthUsd,
      error: wallet.error ?? null,
    }, { status: 200 })
  } catch (error) {
    console.error("[API] /admin/billing/batchdata-wallet GET error:", error)
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    )
  }
}
