import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { buildShowingSentimentSummary } from "@/app/actions/seller-showing-sentiment"

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization") ?? ""
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  }

  const contextResult = await createCronRunContextAction({
    cron_name: "seller-updates",
    cron_path: "/app/api/cron/seller-updates/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  const startRecordResult = await recordCronStartAction({ context_id: contextId })
  if (!startRecordResult.success) {
    console.error("[SellerUpdates] Failed to record cron start:", startRecordResult.error)
  }

  const ranAt = new Date().toISOString()
  const supabase = createServiceClient()
  const errors: string[] = []
  let processed = 0
  let skipped = 0

  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

    const { data: listings, error } = await supabase
      .from("listings")
      .select("id, agent_id, contact_id, property_address, lifecycle_stage")
      .in("lifecycle_stage", ["active", "under_contract"])
      .or(`last_seller_update_at.is.null,last_seller_update_at.lt.${sevenDaysAgo}`)
      .limit(50)

    if (error) {
      errors.push(`Listings query failed: ${error.message}`)
    } else {
      for (const listing of listings ?? []) {
        try {
          // Build the heat-map summary from the past week's showing feedback.
          // Stored on seller_updates so the seller portal can render it
          // without recomputing — agents see the same payload in the
          // listing detail "Showing Sentiment" panel.
          const sentiment = await buildShowingSentimentSummary(listing.id).catch((err) => {
            console.warn(`[seller-updates] sentiment failed for ${listing.id}:`, err)
            return null
          })

          await supabase.from("activities").insert({
            agent_id: listing.agent_id,
            contact_id: listing.contact_id,
            activity_type: "seller_update_due",
            title: `Seller update due for ${listing.property_address}`,
            description: sentiment
              ? `Weekly summary ready: ${sentiment.feedbackCount} feedback / ${sentiment.showingCount} showings. ${sentiment.recommendedAction}`
              : "No seller update sent in 7+ days. Consider sending an update.",
            status: "pending",
            priority: "medium",
            metadata: { listing_id: listing.id, sentiment },
          })

          if (sentiment && sentiment.feedbackCount > 0) {
            await supabase.from("seller_updates").insert({
              listing_id: listing.id,
              update_type: "showing_sentiment_weekly",
              window_start: sentiment.windowStart,
              window_end: sentiment.windowEnd,
              payload: sentiment,
              created_at: ranAt,
            }).catch(() => { /* table may not exist yet — non-fatal */ })
          }

          processed++
        } catch (err: any) {
          skipped++
          errors.push(`Listing ${listing.id}: ${err.message}`)
        }
      }
    }
  } catch (err: any) {
    errors.push(`Seller updates cron failed: ${err.message}`)
    void supabase
      .from("automation_errors")
      .insert({ cron_job: "seller-updates", error_message: err.message, occurred_at: ranAt })
    await recordCronFailureAction({ context_id: contextId, error: err, stage: "main-processing" })
  }

  if (errors.length === 0) {
    await recordCronSuccessAction({ context_id: contextId, records_processed: processed, metadata: { ranAt, skipped, errors } })
  }

  return NextResponse.json({ ok: errors.length === 0, ranAt, processed, skipped, errors })
}
