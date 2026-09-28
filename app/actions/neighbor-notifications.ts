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
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { revalidatePath } from "next/cache"
import { resolveAgentIdInBrokerage } from "@/lib/kernel/agent-identity"
// THE ONE CREATOR of a user-authored direct mail campaign row (wave 85D).
import { createDirectMailCampaign as fileDirectMailCampaign } from "@/lib/kernel/marketing"

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
 * THE TENANT IS THE SESSION'S (§4, wave 85D). Three exports below ran on the SERVICE client
 * keyed on a body-supplied `brokerageId`. That is the IDOR shape: a caller naming another
 * brokerage's id created, approved and launched that tenant's neighbour mailers. The
 * argument stays as a cross-check only, and a foreign id is refused. Module-private, so it
 * is not an endpoint.
 */
async function sessionTenant(claimedBrokerageId: string): Promise<
  { ok: true; userId: string; brokerageId: string } | { ok: false; error: string }
> {
  const actor = await getAgentContext()
  if (!actor.isAuthenticated || !actor.userId || !actor.brokerageId) {
    return { ok: false, error: "Not signed in to a brokerage — a neighbour notification belongs to a signed-in brokerage user" }
  }
  if (claimedBrokerageId && claimedBrokerageId !== actor.brokerageId) {
    return { ok: false, error: "That brokerage is not yours — a neighbour notification is run in your own brokerage" }
  }
  return { ok: true, userId: actor.userId, brokerageId: actor.brokerageId }
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
  const tenant = await sessionTenant(params.brokerageId)
  if (!tenant.ok) return { success: false, error: tenant.error }
  params = { ...params, brokerageId: tenant.brokerageId }
  const supabase = createServiceClient()

  // agent_user_id is a USERS id (the campaign's owner). It arrives in the body, so it must
  // name a user IN the session tenant, or it is refused.
  const { data: ownerRow, error: ownerErr } = await supabase
    .from("users").select("id").eq("id", params.agentUserId).eq("brokerage_id", tenant.brokerageId).maybeSingle()
  if (ownerErr) return { success: false, error: `Could not verify the campaign owner: ${ownerErr.message}` }
  if (!ownerRow) return { success: false, error: "That agent is not a user in your brokerage" }

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
    const { error: recipientsInsErr } = await supabase.from("neighbor_notification_recipients").insert(
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
    if (recipientsInsErr) return { success: false, error: `Campaign created, but its recipients were not saved: ${recipientsInsErr.message}` }

    const { error: identifiedCountErr } = await supabase
      .from("neighbor_notification_campaigns")
      .update({ recipients_identified: candidates.length, updated_at: new Date().toISOString() })
      .eq("id", campaign.id)
    if (identifiedCountErr) console.error(`[neighbor-notifications] recipients_identified NOT updated: ${identifiedCountErr.message}`)
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
  const tenant = await sessionTenant(params.brokerageId)
  if (!tenant.ok) return { success: false, error: tenant.error }
  const supabase = createServiceClient()

  // COUNTED (§3): an update that matches nothing (foreign or gone campaign) also resolves.
  const { data: granted, error } = await supabase
    .from("neighbor_notification_campaigns")
    .update({
      seller_permission_granted: true,
      seller_permission_granted_at: new Date().toISOString(),
      seller_permission_granted_by: params.sellerContactId,
      status: "approved",
      updated_at: new Date().toISOString(),
    })
    .eq("id", params.campaignId)
    .eq("brokerage_id", tenant.brokerageId)
    .select("id")

  if (error) return { success: false, error: error.message }
  if ((granted ?? []).length !== 1) return { success: false, error: "Neighbour notification campaign not found in your brokerage — no permission was recorded" }
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
}): Promise<{ success: boolean; staged?: number; note?: string; error?: string }> {
  const tenant = await sessionTenant(params.brokerageId)
  if (!tenant.ok) return { success: false, error: tenant.error }
  params = { ...params, brokerageId: tenant.brokerageId }
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
  const { error: markSendingErr } = await supabase
    .from("neighbor_notification_campaigns")
    .update({ status: "sending", updated_at: new Date().toISOString() })
    .eq("id", params.campaignId)
  if (markSendingErr) return { success: false, error: `Could not start the send: ${markSendingErr.message}` }

  // Create direct mail campaign + recipients via existing infrastructure.
  // This integrates with the existing createDirectMailCampaign action.
  try {
    const { data: recipients } = await supabase
      .from("neighbor_notification_recipients")
      .select("id, property_address, property_city, property_state, property_zip, owner_name")
      .eq("campaign_id", params.campaignId)
      .eq("status", "identified")

    // TOMBSTONE (wave 85D, §1.1): the raw direct_mail_campaigns insert that lived here MERGED
    // onto the one creator, lib/kernel/marketing.ts createDirectMailCampaign. It wrote
    // neighbor_notification_campaigns.agent_user_id, a USERS id, into agent_id, which FKs
    // AGENTS (23503 whenever an owner was set), and it skipped the feature gate and the
    // DIRECT_MAIL_CAMPAIGN_CREATED event. The owner's agents row is now crossed through
    // lib/kernel/agent-identity.ts resolveAgentIdInBrokerage, pinned to the session tenant,
    // and the creator re-verifies it.
    const ownerUserId = (campaign as { agent_user_id: string | null }).agent_user_id
    const ownerAgentId = ownerUserId ? await resolveAgentIdInBrokerage(supabase, ownerUserId, tenant.brokerageId) : null
    const recipientCount = (recipients ?? []).length
    const filed = await fileDirectMailCampaign({
      ctx: { userId: tenant.userId, brokerageId: tenant.brokerageId, agentId: ownerAgentId ?? undefined },
      campaignName: `Neighbor Notification — ${(campaign as { listing_id: string }).listing_id}`,
      targetAudience: "neighbors_of_new_listing",
      quantity: Math.max(1, recipientCount),
      pieceType: "postcard",
      copyText: "Your neighbor just listed their home — know anyone who'd love to live nearby?",
      client: supabase,
    })
    if (!filed.success || !filed.data) {
      throw new Error(filed.error ?? "Failed to create direct mail campaign")
    }
    const dmCampaign = { id: filed.data.campaignId }

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
        delivery_status: "queued",
      }))
      const { error: dmRecipientsErr } = await supabase.from("direct_mail_recipients").insert(dmRecipientRows)
      if (dmRecipientsErr) throw new Error(`Direct-mail recipients were not staged: ${dmRecipientsErr.message}`)
    }

    // STAGED, NOT SENT. This used to write status:"sent" and
    // recipients_sent:N the instant the rows were inserted, and nothing had
    // been mailed. The Lob drain (runDirectMailCampaignDrain) only picks up
    // rows with approval_status="approved" AND a contact_id or lead_id; this
    // campaign has neither, and the drain's own comment says audience
    // campaigns "belong to their own dispatchers" — of which
    // neighbors_of_new_listing has none. So the postcards sit forever while
    // the ledger claims they went out, and recipients_sent (a DELIVERED
    // count) is inflated for reporting and for spend reconciliation.
    //
    // The truthful terminal state is "sending": staged and awaiting a
    // dispatcher. Nothing here fabricates a send, and recipients_sent stays
    // untouched until something actually mails.
    const { error: dmLinkErr } = await supabase
      .from("neighbor_notification_campaigns")
      .update({
        direct_mail_campaign_id: dmCampaign.id,
        status: "sending",
        updated_at: new Date().toISOString(),
      })
      .eq("id", params.campaignId)
    if (dmLinkErr) throw new Error(`Direct-mail campaign created but not linked to the neighbor campaign: ${dmLinkErr.message}`)

    // Mark recipients as queued
    const { error: queuedErr } = await supabase
      .from("neighbor_notification_recipients")
      .update({ status: "queued" })
      .eq("campaign_id", params.campaignId)
      .eq("status", "identified")
    if (queuedErr) console.error(`[neighbor-notifications] recipients NOT marked queued: ${queuedErr.message}`)

    revalidatePath(`/dashboard/listings`)
    return {
      success: true,
      staged: recipientsList.length,
      note: "Postcards are staged for mailing. A neighbor-mail dispatcher must approve and release them before anything is printed — nothing has been sent yet.",
    }
  } catch (err: any) {
    const { error: resetDraftErr } = await supabase
      .from("neighbor_notification_campaigns")
      .update({ status: "draft", updated_at: new Date().toISOString() })
      .eq("id", params.campaignId)
    if (resetDraftErr) console.error(`[neighbor-notifications] failed send could NOT be reset to draft (it will read as sending): ${resetDraftErr.message}`)
    return { success: false, error: err.message ?? "Direct mail send failed" }
  }
}

/**
 * Read campaigns for a listing
 */
/**
 * Read campaigns for a listing — the caller's own brokerage only.
 *
 * GATED + TENANT-SCOPED (was neither). `"use server"`, no session, and
 * `.eq("listing_id", …)` as the only predicate: a listing uuid returned another
 * brokerage's neighbour-notification campaign posture, including whether seller
 * permission was granted and how many neighbours had already been mailed. Only
 * the table's RLS stood in the way, and this file's other three exports run on
 * `createServiceClient()` — one refactor away from bypassing it entirely.
 *
 * `brokerage_id` is a real column on `neighbor_notification_campaigns` (verified
 * live), so the predicate is always valid.
 */
export async function listNeighborCampaignsForListing(
  listingId: string
): Promise<NeighborNotificationCampaign[]> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return []

  const supabase = await createClient()

  const { data, error } = await supabase
    .from("neighbor_notification_campaigns")
    .select(
      "id, listing_id, brokerage_id, status, seller_permission_granted, " +
        "recipients_identified, recipients_sent, responses_received, " +
        "max_neighbors, search_radius_meters, created_at"
    )
    .eq("listing_id", listingId)
    .eq("brokerage_id", ctx.brokerageId)
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

/**
 * The roster behind "N neighbors identified" (lane M2).
 *
 * The identify step writes a full scoring record per candidate —
 * knows_buyer_score, proximity_meters, owner_tenure_years,
 * owner_estimated_age, life_stage_match and the scoring_signals breakdown —
 * and nothing ever read any of it: the card asked a seller to authorise mail
 * to 50 households it could not show, and asked the agent to launch it on a
 * bare count. This read is the review surface that permission step implies.
 *
 * The scoring facts are shown for ACCOUNTABILITY — so the human approving
 * the send can see and challenge what the heuristic recorded about their
 * neighbors — not as targeting levers; the heuristic itself lives in
 * identifyNeighborCandidates below.
 *
 * Gated + tenant-scoped like listNeighborCampaignsForListing above: session
 * context, and the campaign is proven to belong to the caller's brokerage
 * before its recipients are read.
 */
export async function listNeighborRecipientsForCampaign(campaignId: string): Promise<
  Array<{
    id: string
    propertyAddress: string
    ownerName: string | null
    status: string | null
    knowsBuyerScore: number | null
    proximityMeters: number | null
    ownerTenureYears: number | null
    ownerEstimatedAge: number | null
    lifeStageMatch: string | null
    scoringSignals: Record<string, unknown> | null
  }>
> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return []

  const supabase = await createClient()

  // Prove the campaign is the caller's before reading its roster. §3: the
  // error is read; a refused or missing campaign yields an empty roster.
  const { data: campaign, error: campaignErr } = await supabase
    .from("neighbor_notification_campaigns")
    .select("id")
    .eq("id", campaignId)
    .eq("brokerage_id", ctx.brokerageId)
    .maybeSingle()
  if (campaignErr) {
    console.error("[neighbor-notifications] campaign ownership read refused:", campaignErr.message)
    return []
  }
  if (!campaign) return []

  const { data, error } = await supabase
    .from("neighbor_notification_recipients")
    .select(
      "id, property_address, owner_name, status, knows_buyer_score, proximity_meters, owner_tenure_years, owner_estimated_age, life_stage_match, scoring_signals"
    )
    .eq("campaign_id", campaignId)
    .eq("brokerage_id", ctx.brokerageId)
    .order("knows_buyer_score", { ascending: false })
    .limit(100)

  if (error) {
    console.error("[neighbor-notifications] recipient roster read refused:", error.message)
    return []
  }

  return ((data ?? []) as Array<{
    id: string
    property_address: string
    owner_name: string | null
    status: string | null
    knows_buyer_score: number | null
    proximity_meters: number | null
    owner_tenure_years: number | null
    owner_estimated_age: number | null
    life_stage_match: string | null
    scoring_signals: Record<string, unknown> | null
  }>).map((r) => ({
    id: r.id,
    propertyAddress: r.property_address,
    ownerName: r.owner_name,
    status: r.status,
    knowsBuyerScore: r.knows_buyer_score != null ? Number(r.knows_buyer_score) : null,
    proximityMeters: r.proximity_meters != null ? Number(r.proximity_meters) : null,
    ownerTenureYears: r.owner_tenure_years != null ? Number(r.owner_tenure_years) : null,
    ownerEstimatedAge: r.owner_estimated_age != null ? Number(r.owner_estimated_age) : null,
    lifeStageMatch: r.life_stage_match,
    scoringSignals: r.scoring_signals,
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
  // REAL scrape via the kernel's BatchData-backed neighbor scraper (was a deferred
  // stub returning []). Single source of truth shared with the automated Farm Play.
  const { realNeighborScraper } = await import("@/lib/kernel/neighbor-farm")
  const found = await realNeighborScraper({
    listingAddress: params.listingAddress, city: null, state: null,
    radiusMeters: params.radiusMeters, maxResults: params.maxResults, minTenureYears: params.minTenureYears,
  }).catch(() => [])
  return found
    .filter((c) => c.knowsBuyerScore >= params.threshold)
    .map((c) => ({
      address: c.address, city: c.city ?? "", state: c.state ?? "", zip: c.zip ?? "",
      ownerName: c.ownerName ?? undefined, tenureYears: c.tenureYears ?? undefined,
      estimatedAge: c.estimatedAge ?? undefined, knowsBuyerScore: c.knowsBuyerScore,
      proximityMeters: c.proximityMeters ?? 0, lifeStageMatch: c.lifeStageMatch ?? undefined,
      signals: c.signals ?? undefined,
    }))
}
