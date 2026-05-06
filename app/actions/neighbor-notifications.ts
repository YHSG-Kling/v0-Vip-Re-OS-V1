"use server"

/**
 * NEIGHBOR NOTIFICATION NETWORK
 *
 * When a listing goes active, the agent can spin up a "tell the neighbors"
 * campaign that:
 *   1. Identifies ~50 nearby properties whose owners are most likely to know
 *      a buyer (long tenure, family stage, proximity)
 *   2. Captures explicit seller permission (audit trail)
 *   3. Routes through the existing direct_mail_campaigns system to send a
 *      personalized "your neighbor just listed — know anyone moving?" piece
 *
 * Sellers become marketing channels — their friends often want to live near
 * them. Built-in viral distribution.
 */

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { revalidatePath } from "next/cache"

export interface NeighborNotificationCampaign {
  id: string
  listingId: string
  brokerageId: string
  status: "draft" | "awaiting_seller_permission" | "approved" | "sending" | "sent" | "cancelled"
  sellerPermissionGranted: boolean
  recipientsIdentified: number
  recipientsSent: number
  responsesReceived: number
  maxNeighbors: number
  searchRadiusMeters: number
  createdAt: string
}

/**
 * Step 1: Create the campaign and identify candidate recipients. Defaults
 * to 50 neighbors within ~0.5 mile, filtered to long-tenure homeowners
 * with a knows_buyer_score >= 0.6.
 *
 * Recipients are seeded from neighborhood_data_sources / public records,
 * scored by an AI heuristic, and inserted into
 * neighbor_notification_recipients pending seller permission + send.
 */
export async function createNeighborNotificationCampaign(params: {
  listingId: string
  brokerageId: string
  agentUserId: string
  maxNeighbors?: number
  searchRadiusMeters?: number
  minTenureYears?: number
  knowsBuyerScoreThreshold?: number
}): Promise<{ success: boolean; campaignId?: string; identified?: number; error?: string }> {
  const supabase = createServiceClient()

  // Verify the listing belongs to the brokerage
  const { data: listing, error: listingErr } = await supabase
    .from("listings")
    .select("id, brokerage_id, agent_id, address, status")
    .eq("id", params.listingId)
    .maybeSingle()

  if (listingErr || !listing) return { success: false, error: "Listing not found" }
  if (listing.brokerage_id !== params.brokerageId) {
    return { success: false, error: "Listing does not belong to this brokerage" }
  }

  // Create the campaign row in awaiting_seller_permission state
  const { data: campaign, error: campaignErr } = await supabase
    .from("neighbor_notification_campaigns")
    .insert({
      brokerage_id: params.brokerageId,
      agent_user_id: params.agentUserId,
      listing_id: params.listingId,
      max_neighbors: params.maxNeighbors ?? 50,
      search_radius_meters: params.searchRadiusMeters ?? 800,
      min_tenure_years: params.minTenureYears ?? 5,
      knows_buyer_score_threshold: params.knowsBuyerScoreThreshold ?? 0.6,
      status: "awaiting_seller_permission",
    })
    .select("id")
    .single()

  if (campaignErr || !campaign) {
    return { success: false, error: campaignErr?.message ?? "Failed to create campaign" }
  }

  // Identify candidate recipients. In production this calls a property-records
  // service (BatchData / public records) to get owner-occupied homes within
  // the search radius and scores them. The scoring stub below is structured
  // so a real provider integration is a drop-in replacement.
  const candidates = await identifyNeighborCandidates({
    listingAddress: listing.address ?? "",
    radiusMeters: params.searchRadiusMeters ?? 800,
    maxResults: params.maxNeighbors ?? 50,
    minTenureYears: params.minTenureYears ?? 5,
    threshold: params.knowsBuyerScoreThreshold ?? 0.6,
  })

  // Insert recipients
  if (candidates.length > 0) {
    await supabase.from("neighbor_notification_recipients").insert(
      candidates.map((c) => ({
        campaign_id: campaign.id,
        brokerage_id: params.brokerageId,
        property_address: c.address,
        property_city: c.city,
        property_state: c.state,
        property_zip: c.zip,
        owner_name: c.ownerName ?? null,
        owner_tenure_years: c.tenureYears ?? null,
        owner_estimated_age: c.estimatedAge ?? null,
        knows_buyer_score: c.knowsBuyerScore,
        proximity_meters: c.proximityMeters,
        life_stage_match: c.lifeStageMatch ?? null,
        scoring_signals: c.signals ?? null,
        status: "identified",
      }))
    )

    await supabase
      .from("neighbor_notification_campaigns")
      .update({ recipients_identified: candidates.length, updated_at: new Date().toISOString() })
      .eq("id", campaign.id)
  }

  revalidatePath(`/dashboard/listings/${params.listingId}`)
  return { success: true, campaignId: campaign.id, identified: candidates.length }
}

/**
 * Step 2: Seller grants permission. Without this, the campaign cannot send.
 * Logged with timestamp + seller contact_id for audit.
 */
export async function grantSellerPermission(params: {
  campaignId: string
  sellerContactId: string
  brokerageId: string
}): Promise<{ success: boolean; error?: string }> {
  const supabase = createServiceClient()

  const { error } = await supabase
    .from("neighbor_notification_campaigns")
    .update({
      seller_permission_granted: true,
      seller_permission_granted_at: new Date().toISOString(),
      seller_permission_granted_by: params.sellerContactId,
      status: "approved",
      updated_at: new Date().toISOString(),
    })
    .eq("id", params.campaignId)
    .eq("brokerage_id", params.brokerageId)

  if (error) return { success: false, error: error.message }
  return { success: true }
}

/**
 * Step 3: Launch the campaign. Creates a direct_mail_campaigns entry,
 * pushes recipients into direct_mail_recipients, and triggers the existing
 * Lob-based send pipeline. Cannot fire until seller permission is granted.
 */
export async function launchNeighborNotification(params: {
  campaignId: string
  brokerageId: string
}): Promise<{ success: boolean; sent?: number; error?: string }> {
  const supabase = createServiceClient()

  const { data: campaign } = await supabase
    .from("neighbor_notification_campaigns")
    .select("*")
    .eq("id", params.campaignId)
    .eq("brokerage_id", params.brokerageId)
    .maybeSingle()

  if (!campaign) return { success: false, error: "Campaign not found" }
  if (!(campaign as { seller_permission_granted: boolean }).seller_permission_granted) {
    return { success: false, error: "Seller permission required before send" }
  }

  // Mark sending
  await supabase
    .from("neighbor_notification_campaigns")
    .update({ status: "sending", updated_at: new Date().toISOString() })
    .eq("id", params.campaignId)

  // Create direct mail campaign + recipients via existing infrastructure.
  // This integrates with the existing createDirectMailCampaign action.
  try {
    const { data: recipients } = await supabase
      .from("neighbor_notification_recipients")
      .select("id, property_address, property_city, property_state, property_zip, owner_name")
      .eq("campaign_id", params.campaignId)
      .eq("status", "identified")

    // Insert a direct_mail_campaigns row directly so we have a campaign_id
    // tying neighbor recipients to the existing direct mail pipeline.
    const { data: dmCampaign, error: dmErr } = await supabase
      .from("direct_mail_campaigns")
      .insert({
        brokerage_id: params.brokerageId,
        agent_id: (campaign as { agent_user_id: string | null }).agent_user_id,
        campaign_name: `Neighbor Notification — ${(campaign as { listing_id: string }).listing_id}`,
        target_audience: "neighbors_of_new_listing",
        mailing_type: "postcard",
        status: "queued",
        copy_text: "Your neighbor just listed their home — know anyone who'd love to live nearby?",
      })
      .select("id")
      .single()

    if (dmErr || !dmCampaign) {
      throw new Error(dmErr?.message ?? "Failed to create direct mail campaign")
    }

    // Push recipients into direct_mail_recipients
    const recipientsList = (recipients ?? []) as Array<{
      id: string
      property_address: string
      property_city: string | null
      property_state: string | null
      property_zip: string | null
      owner_name: string | null
    }>

    if (recipientsList.length > 0) {
      const dmRecipientRows = recipientsList.map((r) => ({
        campaign_id: dmCampaign.id,
        brokerage_id: params.brokerageId,
        first_name: r.owner_name?.split(" ")[0] ?? "Neighbor",
        last_name: r.owner_name?.split(" ").slice(1).join(" ") ?? "",
        address_line1: r.property_address,
        city: r.property_city ?? "",
        state: r.property_state ?? "",
        zip: r.property_zip ?? "",
        status: "queued",
      }))
      await supabase.from("direct_mail_recipients").insert(dmRecipientRows)
    }

    await supabase
      .from("neighbor_notification_campaigns")
      .update({
        direct_mail_campaign_id: dmCampaign.id,
        status: "sent",
        recipients_sent: recipientsList.length,
        updated_at: new Date().toISOString(),
      })
      .eq("id", params.campaignId)

    // Mark recipients as queued
    await supabase
      .from("neighbor_notification_recipients")
      .update({ status: "queued" })
      .eq("campaign_id", params.campaignId)
      .eq("status", "identified")

    revalidatePath(`/dashboard/listings`)
    return { success: true, sent: recipientsList.length }
  } catch (err: any) {
    await supabase
      .from("neighbor_notification_campaigns")
      .update({ status: "draft", updated_at: new Date().toISOString() })
      .eq("id", params.campaignId)
    return { success: false, error: err.message ?? "Direct mail send failed" }
  }
}

/**
 * Read campaigns for a listing
 */
export async function listNeighborCampaignsForListing(
  listingId: string
): Promise<NeighborNotificationCampaign[]> {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("neighbor_notification_campaigns")
    .select(
      "id, listing_id, brokerage_id, status, seller_permission_granted, " +
        "recipients_identified, recipients_sent, responses_received, " +
        "max_neighbors, search_radius_meters, created_at"
    )
    .eq("listing_id", listingId)
    .order("created_at", { ascending: false })

  if (error || !data) return []

  return (data as unknown as Array<{
    id: string
    listing_id: string
    brokerage_id: string
    status: NeighborNotificationCampaign["status"]
    seller_permission_granted: boolean
    recipients_identified: number
    recipients_sent: number
    responses_received: number
    max_neighbors: number
    search_radius_meters: number
    created_at: string
  }>).map((row) => ({
    id: row.id,
    listingId: row.listing_id,
    brokerageId: row.brokerage_id,
    status: row.status,
    sellerPermissionGranted: row.seller_permission_granted,
    recipientsIdentified: row.recipients_identified,
    recipientsSent: row.recipients_sent,
    responsesReceived: row.responses_received,
    maxNeighbors: row.max_neighbors,
    searchRadiusMeters: row.search_radius_meters,
    createdAt: row.created_at,
  }))
}

// ─── Internal: Candidate identification ──────────────────────────────────────

interface NeighborCandidate {
  address: string
  city: string
  state: string
  zip: string
  ownerName?: string
  tenureYears?: number
  estimatedAge?: number
  knowsBuyerScore: number
  proximityMeters: number
  lifeStageMatch?: string
  signals?: Record<string, unknown>
}

/**
 * Identify candidate neighbors. STUB — production should integrate with a
 * property-records provider (BatchData, ATTOM, etc.) to fetch nearby owner-
 * occupied homes with tenure data, then score each.
 *
 * Scoring heuristic (when real data is available):
 *   - long tenure (>5 years) → +0.3
 *   - family-with-kids life stage → +0.2 (active social network)
 *   - empty-nester recently → +0.15 (referrals to kids)
 *   - high estimated home value → +0.1
 *   - long social presence in area → +0.15
 *   - proximity (< 200m) → +0.1
 *
 * Returns at most maxResults candidates with score >= threshold.
 */
async function identifyNeighborCandidates(params: {
  listingAddress: string
  radiusMeters: number
  maxResults: number
  minTenureYears: number
  threshold: number
}): Promise<NeighborCandidate[]> {
  // Implementation deferred to property-records provider integration.
  // Returning empty array here lets the campaign be created with
  // recipients_identified = 0; the agent can re-run identification once
  // the provider is connected, or upload a recipient list manually.
  return []
}
