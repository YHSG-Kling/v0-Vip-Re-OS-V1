import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { buildShowingSentimentSummary } from "@/app/actions/seller-showing-sentiment"
import { verifyCronAuth } from "@/lib/cron-auth"

export async function GET(req: NextRequest) {
  // Cron auth — see lib/cron-auth.ts
  const unauth = verifyCronAuth(req)
  if (unauth) return unauth

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
  let marketingCards = 0

  try {
    // Pick active / under-contract listings whose most recent seller-update
    // activity is older than 7 days. We can't filter directly on a
    // `last_seller_update_at` column (it isn't on listings) so we look at the
    // newest seller_update_due / seller_update_sent activity per listing.
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

    const { data: listings, error } = await supabase
      .from("listings")
      .select("id, agent_id, brokerage_id, seller_contact_id, contact_id, address, city, state, lifecycle_stage")
      // listings.lifecycle_stage is UPPER_SNAKE. This read ["active","under_contract"],
      // neither of which is in the CHECK vocabulary, so this cron selected ZERO
      // listings on every run and no seller ever received an update.
      .in("lifecycle_stage", ["MLS_ACTIVE", "UNDER_CONTRACT"])
      .limit(50)

    if (error) {
      errors.push(`Listings query failed: ${error.message}`)
    } else {
      for (const listing of listings ?? []) {
        try {
          const { data: lastUpdate } = await supabase
            .from("activities")
            .select("created_at")
            .eq("entity_type", "listing")
            .in("activity_type", ["seller_update_due", "seller_update_sent"])
            .or(`description.ilike.%${listing.id}%`)
            .gte("created_at", sevenDaysAgo)
            .limit(1)
            .maybeSingle()

          if (lastUpdate) {
            // Already touched this week — skip.
            skipped++
            continue
          }

          // Build the heat-map summary from the past week's showing feedback.
          // Surfaced via the activity description so the agent's CRM picks it
          // up without an extra side-table.
          const sentiment = await buildShowingSentimentSummary(listing.id).catch((err) => {
            console.warn(`[seller-updates] sentiment failed for ${listing.id}:`, err)
            return null
          })

          const sellerContactId = listing.seller_contact_id ?? listing.contact_id ?? null
          const propertyAddress = [listing.address, listing.city, listing.state].filter(Boolean).join(", ")

          await supabase.from("activities").insert({
            agent_id: listing.agent_id,
            brokerage_id: listing.brokerage_id,
            contact_id: sellerContactId,
            entity_type: "listing",
            activity_type: "seller_update_due",
            title: `Seller update due for ${propertyAddress || listing.id}`,
            description: sentiment
              ? `Weekly summary: ${sentiment.feedbackCount} feedback / ${sentiment.showingCount} showings. ${sentiment.recommendedAction} (listing:${listing.id})`
              : `No seller update sent in 7+ days. Consider sending an update. (listing:${listing.id})`,
            status: "pending",
            priority: "medium",
            notes: sentiment ? JSON.stringify(sentiment) : null,
          })

          // MANAGER-ORCHESTRATED, NOT LINEAR — when the feedback points at a play (price pressure /
          // strong interest / presentation), hand it to the Listing Concierge over the bus so it
          // proposes a GATED seller recommendation. The activity above is the record; this is the team
          // acting. Best-effort; these are in-house listings by construction.
          if (sentiment && sentiment.feedbackCount > 0) {
            try {
              const { routeAndPublishShowingFeedback } = await import("@/lib/intelligence/showing-feedback-routing-runner")
              await routeAndPublishShowingFeedback({
                brokerageId: listing.brokerage_id, listingId: listing.id, sellerContactId,
                propertyAddress, isInHouse: true,
                summary: {
                  pricingPressure: sentiment.pricingPressure,
                  objections: sentiment.objections,
                  positiveThemes: sentiment.positiveThemes,
                  feedbackCount: sentiment.feedbackCount,
                  highInterestCount: sentiment.highInterestCount,
                  lowInterestCount: sentiment.lowInterestCount,
                },
              }, supabase)
            } catch (err) {
              console.warn(`[seller-updates] showing-feedback routing failed for ${listing.id}:`, err)
            }
          }

          // MARKETING RECEIPT — the consolidated "what your team's marketing DID this week"
          // portal card for the seller (published social posts + completed promo videos,
          // one card per listing per week — the helper carries its own weekly dedupe).
          // Autonomous by design (the tour-recap portal-card idiom); best-effort, never
          // blocks the seller-update rail itself.
          if (sellerContactId) {
            try {
              const { pushWeeklyMarketingCard } = await import("@/lib/kernel/listing-marketing-week")
              const receipt = await pushWeeklyMarketingCard({
                brokerageId: listing.brokerage_id,
                listingId: listing.id,
                sellerContactId,
                address: propertyAddress || "your listing",
              }, supabase)
              if (receipt.pushed) marketingCards++
            } catch (err) {
              console.warn(`[seller-updates] marketing receipt failed for ${listing.id}:`, err)
            }
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
      .insert({ workflow_name: "seller-updates", error_message: err.message, severity: "error", created_at: ranAt })
    await recordCronFailureAction({ context_id: contextId, error: err, stage: "main-processing" })
  }

  if (errors.length === 0) {
    await recordCronSuccessAction({ context_id: contextId, records_processed: processed, metadata: { ranAt, skipped, marketingCards, errors } })
  }

  return NextResponse.json({ ok: errors.length === 0, ranAt, processed, skipped, marketingCards, errors })
}
