import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { requireBrokerAuth } from "@/lib/kernel/api-auth"
import { processRawRecord } from "@/lib/lead-pipeline"

export const dynamic = "force-dynamic"
export const maxDuration = 300

/**
 * API Route: Process Raw Leads Through Pipeline (manual broker trigger)
 * POST /api/leads/process-pipeline
 *
 * Promotes pending rows from the canonical raw_scraped_leads table through the
 * full pipeline (territory → identity → dedup → enrichment → promotion) via
 * processRawRecord. This is the on-demand counterpart to the scheduled
 * promotion pass in the lead-scraping cron — both read raw_scraped_leads.
 *
 * Body: { limit?: number (default 50), brokerage_id?: uuid (superadmin only) }
 */
export async function POST(request: NextRequest) {
  // Auth check: only brokers/admins can trigger pipeline processing
  const userSupabase = await createClient()
  const auth = await requireBrokerAuth(userSupabase)
  if (!auth.ok) return auth.response

  try {
    const body = await request.json().catch(() => ({}))
    const { limit = 50, brokerage_id: requestedBrokerageId } = body

    // Non-superadmins are locked to their own brokerage.
    if (
      requestedBrokerageId &&
      requestedBrokerageId !== auth.brokerageId &&
      auth.userType !== "superadmin"
    ) {
      return NextResponse.json(
        { error: "Cannot process pipeline for a different brokerage" },
        { status: 403 }
      )
    }

    const brokerage_id = requestedBrokerageId ?? auth.brokerageId

    const supabase = createServiceClient()

    // Pending raw records on the canonical table, oldest first.
    const { data: rawRecords, error: fetchError } = await supabase
      .from("raw_scraped_leads")
      .select("id")
      .eq("brokerage_id", brokerage_id)
      .eq("processing_status", "pending")
      .order("created_at", { ascending: true })
      .limit(limit)

    if (fetchError) {
      console.error("[process-pipeline] Error fetching raw records:", fetchError)
      return NextResponse.json({ error: fetchError.message }, { status: 500 })
    }

    if (!rawRecords || rawRecords.length === 0) {
      return NextResponse.json({
        message: "No pending records found",
        processed: 0,
        created: 0,
        skipped: 0,
      })
    }

    const results = {
      processed: 0,
      created: 0,
      skipped: 0,
      errors: [] as string[],
    }

    // processRawRecord reads raw_scraped_leads and updates lead_id +
    // processing_status itself — no manual raw-row update needed here.
    for (const raw of rawRecords) {
      try {
        const result = await processRawRecord(raw.id, brokerage_id)
        results.processed++
        if (result.action === "created" || result.action === "merged") {
          results.created++
        } else if (result.action === "skipped") {
          results.skipped++
        }
      } catch (error) {
        results.errors.push(`Error processing record ${raw.id}: ${error}`)
      }
      // Rate limiting between enrichment API calls
      await new Promise((resolve) => setTimeout(resolve, 500))
    }

    return NextResponse.json({ message: "Pipeline processing complete", ...results })
  } catch (error) {
    console.error("[process-pipeline] Pipeline processing error:", error)
    return NextResponse.json({ error: String(error) }, { status: 500 })
  }
}

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
