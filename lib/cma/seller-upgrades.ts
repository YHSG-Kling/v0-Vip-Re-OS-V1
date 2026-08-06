/**
 * SELLER-REPORTED UPGRADES → the CMA.
 *
 * The owner's CMA ruling ends with: "uses the state appraiser guidelines as well
 * as any upgrades the seller has done to the home since purchasing it (seller
 * provides)."
 *
 * No new column was needed for this. `property_upgrades` already stores exactly
 * that record — listing-scoped, brokerage-anchored, written today by
 * app/actions/intent-writers.ts logUpgrade (the voice/admin "log an upgrade"
 * intent) and read by the seller CMA page (app/actions/seller-cma.ts) and the
 * appraiser packet (lib/kernel/appraiser-packet.ts gatherSellerUpgrades). This
 * module is the third reader, so the CMA and the appraiser packet describe the
 * same upgrades from the same row rather than from two different lists.
 */

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import type { SellerUpgrade } from "./comp-types"

/**
 * Load the seller's completed/approved upgrades for a listing.
 *
 * Tenant-anchored on brokerage_id as well as listing_id: this is reachable from
 * a request-supplied listing id, and a listing id from a request body is not
 * proof of tenancy.
 *
 * Only 'completed' and 'approved' rows are returned. A 'suggested' upgrade is
 * something the system PROPOSED and the seller has not done — feeding it to a
 * valuation would value work that does not exist. 'declined' likewise.
 * (Live CHECK on property_upgrades.status: suggested | approved | completed |
 * declined — verified against pg_get_constraintdef, no widening needed.)
 *
 * Returns [] and logs on a refused read: an unreadable upgrade list is "we do
 * not know", which is what an empty list means to every caller here.
 */
export async function loadSellerUpgradesForListing(params: {
  listingId: string
  brokerageId: string
}): Promise<SellerUpgrade[]> {
  if (!params.listingId || !params.brokerageId) return []

  const svc = createServiceClient()
  const { data, error } = await svc
    .from("property_upgrades")
    .select("upgrade_description, estimated_cost, status, created_at")
    .eq("brokerage_id", params.brokerageId)
    .eq("listing_id", params.listingId)
    .in("status", ["completed", "approved"])
    .order("created_at", { ascending: false })

  if (error) {
    console.error("[cma/seller-upgrades] property_upgrades read refused:", error.message)
    return []
  }

  const upgrades: SellerUpgrade[] = []
  for (const row of data ?? []) {
    const r = row as {
      upgrade_description: string | null
      estimated_cost: number | string | null
      created_at: string | null
    }
    const description = (r.upgrade_description ?? "").trim()
    if (!description) continue
    const cost = r.estimated_cost != null ? Number(r.estimated_cost) : null
    upgrades.push({
      description,
      estimatedCost: cost != null && Number.isFinite(cost) && cost > 0 ? cost : null,
      // property_upgrades has no completion-date column — created_at is the
      // only timestamp, so it is surfaced as the date the upgrade was RECORDED.
      // The narrative says "recorded", not "completed", for exactly this reason.
      completedOn: r.created_at ? String(r.created_at).slice(0, 10) : null,
    })
  }
  return upgrades
}
