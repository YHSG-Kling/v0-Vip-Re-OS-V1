import {
NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { calculateListingHealth } from "@/lib/listing-health/health-scorer"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"

export const dynamic = "force-dynamic"

/**
 * Listing Health Scan Cron
 *
 * GET:  Scheduled scan of all active listings (12-hour interval)
 * POST: Single listing rescan (triggered from UI by rescanListingHealthAction)
 *
 * Event emission + intervention creation are handled INSIDE
 * calculateListingHealth(), so this cron stays a thin orchestrator.
 */

export async function GET(request: NextRequest) {
  // Cron auth — see lib/cron-auth.ts
  const unauth = verifyCronAuth(request)
  if (unauth) return unauth

  const ctxResult = await createCronRunContextAction({
    cron_name: "listing-health-scan",
    cron_path: "/app/api/cron/listing-health-scan/route.ts",
  })
  if (!ctxResult.success || !ctxResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = ctxResult.data.context_id
  await recordCronStartAction({ context_id: contextId })

  const supabase = createServiceClient()
  const results: Array<{ listingId: string; score?: number; riskLevel?: string; error?: string }> = []

  try {
    const { data: listings, error } = await supabase
      .from("listings")
      .select("id")
      .in("status", ["active", "coming_soon"])

    if (error) throw new Error(`Failed to fetch listings: ${error.message}`)
    if (!listings || listings.length === 0) {
      await recordCronSuccessAction({ context_id: contextId, records_processed: 0, metadata: { message: "No active listings" } })
      return NextResponse.json({ message: "No active listings to scan", results: [] })
    }

    for (const row of listings) {
      try {
        const r = await calculateListingHealth({ listingId: row.id })
        results.push({ listingId: row.id, score: r.overallScore, riskLevel: r.riskLevel })
      } catch (e) {
        const message = e instanceof Error ? e.message : "Score failed"
        results.push({ listingId: row.id, error: message })
      }
    }

    const atRisk = results.filter((r) => r.riskLevel === "at_risk" || r.riskLevel === "critical").length
    await recordCronSuccessAction({
      context_id:        contextId,
      records_processed: results.length,
      metadata: { at_risk_count: atRisk, error_count: results.filter((r) => r.error).length },
    })

    return NextResponse.json({
      message:  `Scanned ${results.length} listings`,
      atRisk,
      results,
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : "Cron failed"
    await recordCronFailureAction({ context_id: contextId, error: message })
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

/**
 * POST: Single-listing rescan. Used by rescanListingHealthAction so the UI
 * can trigger a fresh score after an agent takes an action (price change,
 * new photos, scheduled open house, etc.).
 */
export async function POST(request: NextRequest) {
  try {
    const { listing_id } = await request.json()
    if (!listing_id) {
      return NextResponse.json({ error: "listing_id required" }, { status: 400 })
    }
    const result = await calculateListingHealth({ listingId: listing_id })
    return NextResponse.json({
      success:      true,
      overallScore: result.overallScore,
      riskLevel:    result.riskLevel,
      scoreDelta:   result.scoreDelta,
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : "Rescan failed"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
