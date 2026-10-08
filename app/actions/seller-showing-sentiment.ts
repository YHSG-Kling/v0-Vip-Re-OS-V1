"use server"

/**
 * app/actions/seller-showing-sentiment.ts
 *
 * Weekly heat-map summary the seller receives for any active listing they
 * own. Aggregates the existing showing_feedback rows (no new tables) into:
 *
 *   • aggregate sentiment (rolling 7d)
 *   • per-rating averages (presentation, cleanliness, overall_impression)
 *   • top positive themes + top objections (extracted with the LLM if
 *     configured; falls back to keyword bucketing)
 *   • pricing-pressure signal (interested vs not-interested ratio)
 *   • recommended next action for the agent
 *
 * Triggered by the seller-updates cron (Mondays 8am) and on-demand from
 * the listing detail page. All writes land in seller_updates.
 */

// TOMBSTONE (wave 139): the builder (buildShowingSentimentSummary + its schema/helpers) moved to
// lib/listings/showing-sentiment.ts — exported from this "use server" file it was a public endpoint.
import { createClient } from "@/lib/supabase/server"
import { buildShowingSentimentSummary } from "@/lib/listings/showing-sentiment"

/** On-demand fetch from the listing detail page (auth + brokerage scoped). */
export async function getShowingSentimentSummaryAction(listingId: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "unauthorized" }
  const { data: callerRow } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .maybeSingle()
  if (!callerRow?.brokerage_id) return { success: false, error: "unauthorized" }

  const { data: listing } = await supabase
    .from("listings")
    .select("brokerage_id")
    .eq("id", listingId)
    .maybeSingle()
  if (!listing) return { success: false, error: "not_found" }
  if (listing.brokerage_id !== callerRow.brokerage_id) {
    return { success: false, error: "forbidden" }
  }

  const summary = await buildShowingSentimentSummary(listingId, {
    brokerageId: listing.brokerage_id ?? null,
    userId: user.id,
  })
  return { success: true, summary }
}
