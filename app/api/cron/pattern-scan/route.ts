import { NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { scanEntityForPatterns } from "@/lib/intelligence/pattern-detector"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"

// Schedule: every 4 hours (0 */4 * * *)
// Batch limit: 50 contacts + 50 listings per run to control AI costs

export async function GET(request: Request) {
  // Verify cron secret
  const authHeader = request.headers.get("authorization")
  const cronSecret = process.env.CRON_SECRET

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const contextResult = await createCronRunContextAction({
    cron_name: "pattern-scan",
    cron_path: "/app/api/cron/pattern-scan/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  const startRecordResult = await recordCronStartAction({ context_id: contextId })
  if (!startRecordResult.success) {
    console.error("[PatternScan] Failed to record cron start:", startRecordResult.error)
  }

  const supabase = createServiceClient()
  const startTime = Date.now()

  const results = {
    contacts_scanned: 0,
    listings_scanned: 0,
    patterns_detected: 0,
    errors: [] as string[],
  }

  try {
    // 1. Fetch active contacts with buyer stage (buyers)
    const { data: contacts, error: contactsError } = await supabase
      .from("contacts")
      .select("id, brokerage_id")
      .not("buyer_stage", "is", null)
      .neq("status", "closed")
      .limit(50)

    if (contactsError) {
      results.errors.push(`Contacts fetch error: ${contactsError.message}`)
    }

    // 2. Fetch active listings (sellers)
    const { data: listings, error: listingsError } = await supabase
      .from("listings")
      .select("id, brokerage_id")
      .eq("status", "active")
      .limit(50)

    if (listingsError) {
      results.errors.push(`Listings fetch error: ${listingsError.message}`)
    }

    // 3. Scan contacts for patterns
    for (const contact of contacts || []) {
      try {
        const detections = await scanEntityForPatterns(
          "contact",
          contact.id,
          contact.brokerage_id
        )
        results.contacts_scanned++
        results.patterns_detected += detections.length
      } catch (error) {
        results.errors.push(
          `Contact ${contact.id}: ${error instanceof Error ? error.message : "Unknown error"}`
        )
      }
    }

    // 4. Scan listings for patterns
    for (const listing of listings || []) {
      try {
        const detections = await scanEntityForPatterns(
          "listing",
          listing.id,
          listing.brokerage_id
        )
        results.listings_scanned++
        results.patterns_detected += detections.length
      } catch (error) {
        results.errors.push(
          `Listing ${listing.id}: ${error instanceof Error ? error.message : "Unknown error"}`
        )
      }
    }

    const duration = Date.now() - startTime

    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: results.contacts_scanned + results.listings_scanned,
      output_count: results.patterns_detected,
      metadata: { ...results, duration_ms: duration },
    })

    return NextResponse.json({
      success: true,
      ...results,
      duration_ms: duration,
    })
  } catch (error) {
    await recordCronFailureAction({ context_id: contextId, error: error as Error | string, stage: "main-processing" })
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
        context_id: contextId,
        ...results,
      },
      { status: 500 }
    )
  }
}
