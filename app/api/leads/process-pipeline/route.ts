import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { requireBrokerAuth } from "@/lib/kernel/api-auth"

export const dynamic = "force-dynamic"
export const maxDuration = 300

/**
 * API Route: Raw-lead pipeline statistics (read-only).
 *
 * CANONICAL PROCESS (owner, round 37): raw leads can't be manually moved to
 * leads — promotion is FULLY AUTOMATIC (the lead-scraping cron's
 * processRawRecord promotion pass + its stranded-record re-enrich sweep). The
 * former POST handler here (an on-demand broker trigger that ran pending raw
 * records through the pipeline) was a manual raw→lead door and has been
 * REMOVED. Only the GET stats endpoint remains.
 */

/**
 * GET /api/leads/process-pipeline
 * Pipeline processing statistics for the caller's brokerage.
 */
export async function GET(request: NextRequest) {
  // Auth check: only brokers/admins can view pipeline stats
  const userSupabase = await createClient()
  const auth = await requireBrokerAuth(userSupabase)
  if (!auth.ok) return auth.response

  try {
    const supabase = createServiceClient()
    const brokerageId = auth.brokerageId

    const statuses = [
      "pending",
      "processing",
      "promoted",
      "error",
      "insufficient_identity_for_promotion",
    ]

    const byStatus: Record<string, number> = {}
    for (const status of statuses) {
      const { count } = await supabase
        .from("raw_scraped_leads")
        .select("*", { count: "exact", head: true })
        .eq("brokerage_id", brokerageId)
        .eq("processing_status", status)
      byStatus[status] = count || 0
    }

    const { count: total } = await supabase
      .from("raw_scraped_leads")
      .select("*", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId)

    // Deduplication stats (skips logged during dedup gates)
    const { count: duplicatesFound } = await supabase
      .from("lead_deduplication_log")
      .select("*", { count: "exact", head: true })
      .eq("action_taken", "skipped")

    // Vendor usage stats
    const { data: vendorCosts } = await supabase
      .from("vendor_usage_tracking")
      .select("vendor_name, total_cost")
      .eq("brokerage_id", brokerageId)

    const costsByVendor: Record<string, number> = {}
    vendorCosts?.forEach((v) => {
      costsByVendor[v.vendor_name] = (costsByVendor[v.vendor_name] || 0) + Number(v.total_cost)
    })

    return NextResponse.json({
      raw_scraped_leads: { total: total || 0, ...byStatus },
      deduplication: { duplicates_found: duplicatesFound || 0 },
      vendor_costs: costsByVendor,
    })
  } catch (error) {
    console.error("[process-pipeline] Error fetching pipeline stats:", error)
    return NextResponse.json({ error: String(error) }, { status: 500 })
  }
}
