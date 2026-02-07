import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { LeadPipelineProcessor } from "@/lib/lead-pipeline/pipeline-processor"

export const dynamic = "force-dynamic"
export const maxDuration = 300

/**
 * API Route: Process Raw Leads Through Pipeline
 * POST /api/leads/process-pipeline
 * 
 * Processes raw scraped leads through the complete enrichment and deduplication pipeline:
 * 1. Fuzzy matching against existing leads/contacts
 * 2. Skip tracing via PeopleData Labs
 * 3. Property image analysis via OpenAI Vision
 * 4. Social media scraping via Apify
 * 5. OSINT background checks
 * 6. Create/update lead records with enriched data
 * 
 * Body:
 * {
 *   raw_table: "batchdata_motivated_sellers_raw" | "zenrows_property_search_raw" | "social_search_raw_results",
 *   limit?: number (default 50),
 *   brokerage_id: uuid
 * }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { raw_table, limit = 50, brokerage_id } = body

    if (!raw_table || !brokerage_id) {
      return NextResponse.json(
        { error: "Missing required fields: raw_table, brokerage_id" },
        { status: 400 }
      )
    }

    const validTables = [
      "batchdata_motivated_sellers_raw",
      "zenrows_property_search_raw",
      "social_search_raw_results"
    ]

    if (!validTables.includes(raw_table)) {
      return NextResponse.json(
        { error: `Invalid raw_table. Must be one of: ${validTables.join(", ")}` },
        { status: 400 }
      )
    }

    const supabase = createServiceClient()
    const pipeline = new LeadPipelineProcessor(supabase)

    console.log(`[v0] Processing ${limit} records from ${raw_table} for brokerage ${brokerage_id}`)

    // Get unprocessed raw records
    const { data: rawRecords, error: fetchError } = await supabase
      .from(raw_table)
      .select("*")
      .is("lead_id", null)
      .limit(limit)

    if (fetchError) {
      console.error("[v0] Error fetching raw records:", fetchError)
      return NextResponse.json({ error: fetchError.message }, { status: 500 })
    }

    if (!rawRecords || rawRecords.length === 0) {
      return NextResponse.json({
        message: "No unprocessed records found",
        processed: 0,
        created: 0,
        skipped: 0,
      })
    }

    console.log(`[v0] Found ${rawRecords.length} unprocessed records`)

    const results = {
      processed: 0,
      created: 0,
      skipped: 0,
      errors: [] as string[],
    }

    // Process each raw record through the pipeline
    for (const raw of rawRecords) {
      try {
        const result = await pipeline.processRawLead({
          rawRecord: raw,
          rawTable: raw_table,
          brokerageId: brokerage_id,
        })

        results.processed++

        if (result.action === "created") {
          results.created++
          console.log(`[v0] Created new lead: ${result.leadId}`)
        } else if (result.action === "skipped") {
          results.skipped++
          console.log(`[v0] Skipped duplicate: ${result.reason}`)
        } else if (result.action === "merged") {
          results.created++
          console.log(`[v0] Merged data into existing lead: ${result.leadId}`)
        }

        // Update raw record with lead_id
        if (result.leadId) {
          await supabase
            .from(raw_table)
            .update({ lead_id: result.leadId })
            .eq("id", raw.id)
        }
      } catch (error) {
        const errorMsg = `Error processing record ${raw.id}: ${error}`
        console.error("[v0]", errorMsg)
        results.errors.push(errorMsg)
      }

      // Rate limiting between API calls
      await new Promise(resolve => setTimeout(resolve, 500))
    }

    console.log("[v0] Pipeline processing complete:", results)

    return NextResponse.json({
      message: "Pipeline processing complete",
      ...results,
    })
  } catch (error) {
    console.error("[v0] Pipeline processing error:", error)
    return NextResponse.json(
      { error: String(error) },
      { status: 500 }
    )
  }
}

/**
 * GET /api/leads/process-pipeline
 * Get pipeline processing statistics
 */
export async function GET(request: NextRequest) {
  try {
    const supabase = createServiceClient()
    const searchParams = request.nextUrl.searchParams
    const brokerageId = searchParams.get("brokerage_id")

    if (!brokerageId) {
      return NextResponse.json(
        { error: "Missing brokerage_id parameter" },
        { status: 400 }
      )
    }

    // Get statistics from raw tables
    const tables = [
      "batchdata_motivated_sellers_raw",
      "zenrows_property_search_raw",
      "social_search_raw_results"
    ]

    const stats: Record<string, any> = {}

    for (const table of tables) {
      const { count: total } = await supabase
        .from(table)
        .select("*", { count: "exact", head: true })

      const { count: processed } = await supabase
        .from(table)
        .select("*", { count: "exact", head: true })
        .not("lead_id", "is", null)

      const { count: pending } = await supabase
        .from(table)
        .select("*", { count: "exact", head: true })
        .is("lead_id", null)

      stats[table] = {
        total: total || 0,
        processed: processed || 0,
        pending: pending || 0,
      }
    }

    // Get deduplication stats
    const { count: duplicatesFound } = await supabase
      .from("lead_deduplication_log")
      .select("*", { count: "exact", head: true })
      .eq("action_taken", "skipped")

    // Get vendor usage stats
    const { data: vendorCosts } = await supabase
      .from("vendor_usage_tracking")
      .select("vendor_name, total_cost")
      .eq("brokerage_id", brokerageId)

    const costsByVendor: Record<string, number> = {}
    vendorCosts?.forEach(v => {
      costsByVendor[v.vendor_name] = (costsByVendor[v.vendor_name] || 0) + Number(v.total_cost)
    })

    return NextResponse.json({
      raw_tables: stats,
      deduplication: {
        duplicates_found: duplicatesFound || 0,
      },
      vendor_costs: costsByVendor,
    })
  } catch (error) {
    console.error("[v0] Error fetching pipeline stats:", error)
    return NextResponse.json(
      { error: String(error) },
      { status: 500 }
    )
  }
}
