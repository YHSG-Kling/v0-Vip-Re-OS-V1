// lib/vendor-marketplace/vendor-ratings.ts
//
// The ONE vendor_ratings booking-rollup recompute (§6, extracted 2026-09-01).
// This logic lived as the body of app/actions/vendor-marketplace.ts ::
// recalculateVendorRatings (which now delegates here) and was needed by a
// second caller with a DIFFERENT client: the portal client-rating action
// (app/actions/contact-vendor-booking.ts :: rateVendorBookingAsClient) runs on
// the SERVICE client — a portal contact's session client cannot read every
// booking or write vendor_ratings under RLS. Duplicating the aggregate math
// would have been two spellings of one rollup, so it is parameterized on the
// client instead.

import "server-only"
import type { SupabaseClient } from "@supabase/supabase-js"

/**
 * Recompute the vendor_ratings aggregate row for one (vendor, brokerage) from
 * the vendor_bookings ratings, and mirror the agent average onto
 * vendors.rating. Callers pass the client whose privileges fit their door:
 * session client for agent-side actions, service client for the portal action
 * (which gates on isContactSelf BEFORE calling — gate first, then service
 * client, per lib/kernel/manager-registry.ts).
 */
export async function recalculateVendorRatingsCore(
  supabase: SupabaseClient,
  vendorId: string,
  brokerageId: string,
): Promise<void> {
  // Get all bookings with ratings for this vendor in this brokerage.
  // §3: destructure and READ the error — a swallowed refusal here would
  // silently freeze the aggregate at its previous value.
  const { data: bookings, error: bookingsError } = await supabase
    .from("vendor_bookings")
    .select("agent_rating, client_rating")
    .eq("vendor_id", vendorId)
    .eq("brokerage_id", brokerageId)

  if (bookingsError) {
    console.error(
      `[vendor-ratings] bookings read refused for vendor ${vendorId}:`,
      bookingsError.message,
    )
    return
  }
  if (!bookings || bookings.length === 0) return

  // Calculate aggregates
  const agentRatings = bookings.filter((b) => b.agent_rating != null).map((b) => b.agent_rating)
  const clientRatings = bookings.filter((b) => b.client_rating != null).map((b) => b.client_rating)
  const fiveStars = agentRatings.filter((r) => r === 5).length
  const oneStars = agentRatings.filter((r) => r === 1).length

  const avgAgentRating = agentRatings.length > 0
    ? agentRatings.reduce((a, b) => a + b, 0) / agentRatings.length
    : null
  const avgClientRating = clientRatings.length > 0
    ? clientRatings.reduce((a, b) => a + b, 0) / clientRatings.length
    : null

  // Upsert vendor_ratings
  const { error } = await supabase
    .from("vendor_ratings")
    .upsert({
      vendor_id: vendorId,
      brokerage_id: brokerageId,
      avg_agent_rating: avgAgentRating,
      avg_client_rating: avgClientRating,
      total_bookings: bookings.length,
      five_star_count: fiveStars,
      one_star_count: oneStars,
      last_updated: new Date().toISOString(),
    }, { onConflict: "vendor_id" })

  if (error) {
    // If unique constraint doesn't exist, insert new record
    const { error: insertError } = await supabase
      .from("vendor_ratings")
      .insert({
        vendor_id: vendorId,
        brokerage_id: brokerageId,
        avg_agent_rating: avgAgentRating,
        avg_client_rating: avgClientRating,
        total_bookings: bookings.length,
        five_star_count: fiveStars,
        one_star_count: oneStars,
        last_updated: new Date().toISOString(),
      })
    if (insertError) {
      console.error(
        `[vendor-ratings] vendor_ratings upsert AND insert refused for vendor ${vendorId}:`,
        insertError.message,
      )
    }
  }

  // Also update the main vendors table rating. vendors.rating carries a CHECK
  // (0 <= rating <= 5) — an out-of-range average is refused outright, and a
  // silent write here kept the directory showing the previous star rating with
  // no sign the recompute had been rejected.
  if (avgAgentRating) {
    const { error: ratingError } = await supabase
      .from("vendors")
      .update({ rating: avgAgentRating })
      .eq("id", vendorId)
    if (ratingError) {
      console.error(
        `[vendor-ratings] vendors.rating update REFUSED for vendor ${vendorId} (value ${avgAgentRating}):`,
        ratingError.message,
      )
    }
  }
}
