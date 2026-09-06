"use server"

/**
 * app/actions/offers/present-to-seller.ts — THE APPROVAL GATE THAT DID NOT EXIST.
 *
 * Owner ruling (wave 12, R4): "any offer that comes in for inside listings, ONCE
 * AGENT APPROVES, is pushed to the seller's portal". Until m387 there was no gate
 * at all: the seller portal filtered on `status`, and an offer written by the
 * inbound-mail lane is inserted as "submitted", so the buyer's name, price and
 * terms were on the seller's screen the instant the webhook returned — before any
 * agent had opened it.
 *
 * `offers.presented_to_seller_at` is the gate. NULL means the seller must not see
 * it. It is set ONLY here, by an authenticated listing-side caller, and is never
 * inferred from `status` — `offers.status` carries no CHECK constraint (verified
 * against the live catalog), so it is not a trustworthy gate for anything.
 *
 * REVERSIBLE by construction. An offer released by mistake must be retractable,
 * and retracting it also removes the portal notification the release raised —
 * otherwise the seller keeps a banner announcing an offer that is no longer on
 * their screen.
 *
 * ID CLASSES. The session yields a `users.id`. `presented_to_seller_by_agent_id`
 * FKs `agents(id)` (verified) — a disjoint uuid space. It is RESOLVED through
 * lib/kernel/agent-identity.ts:resolveAgentId, never `??`-substituted. When the
 * caller holds no agent profile the stamp still lands (the seller's visibility is
 * the point) but the approver column stays NULL and the caller is TOLD, rather
 * than a users id being written into an agents FK where it can never match.
 */

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { resolveAgentId } from "@/lib/kernel/agent-identity"
import { isValidUUID } from "@/lib/validations"
import { revalidatePath } from "next/cache"

// The portal banner's activity type. Read by the seller portal's offers screen;
// written by our own offer wizard at submission and — since this wave — here, at
// the moment the agent actually releases the offer.
const PORTAL_OFFER_NOTIFICATION = "portal_offer_notification"

export interface PresentationState {
  offerId: string
  presentedAt: string | null
  presentedByAgentId: string | null
  note: string | null
}

// ─── Auth ────────────────────────────────────────────────────────────────────
// Same discipline as app/actions/seller-offers.ts:requireCaller — the session is
// the only identity source; caller-supplied brokerage/agent ids are never
// trusted. Releasing an offer to a seller discloses a third party's name, price
// and terms, so this gate is not weaker than the accept/counter/reject gates on
// the same rows.
async function requireCaller(): Promise<
  | { ok: true; userId: string; brokerageId: string }
  | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthorized" }
  const { data: u, error } = await supabase
    .from("users").select("brokerage_id").eq("id", user.id).maybeSingle()
  if (error) return { ok: false, error: error.message }
  if (!u?.brokerage_id) return { ok: false, error: "Unauthorized" }
  return { ok: true, userId: user.id, brokerageId: u.brokerage_id }
}

interface ListingForRelease {
  id: string
  brokerage_id: string | null
  address: string | null
  agent_id: string | null
  seller_contact_id: string | null
  contact_id: string | null
}

/**
 * The listing, ONLY if it belongs to the caller's brokerage. Returns the row so
 * the release can reach the seller contact without a second read. A refused read
 * is reported as a refusal — supabase-js resolves a denied query, and treating
 * "no row" as "not yours" would be right by accident here but wrong the moment
 * this helper is reused, so the error is carried out explicitly.
 */
async function loadListingInCallerBrokerage(
  listingId: string,
  brokerageId: string,
): Promise<{ ok: true; listing: ListingForRelease } | { ok: false; error: string }> {
  if (!isValidUUID(listingId)) return { ok: false, error: "Invalid listing ID" }
  const svc = createServiceClient()
  const { data, error } = await svc
    .from("listings")
    .select("id, brokerage_id, address, agent_id, seller_contact_id, contact_id")
    .eq("id", listingId)
    .maybeSingle()
  if (error) return { ok: false, error: error.message }
  if (!data || data.brokerage_id !== brokerageId) return { ok: false, error: "Forbidden" }
  return { ok: true, listing: data as ListingForRelease }
}

interface OfferForRelease {
  id: string
  brokerage_id: string | null
  listing_id: string | null
  offer_price: number | null
  presented_to_seller_at: string | null
}

async function loadOfferOnListing(
  offerId: string,
  listingId: string,
  brokerageId: string,
): Promise<{ ok: true; offer: OfferForRelease } | { ok: false; error: string }> {
  const svc = createServiceClient()
  const { data, error } = await svc
    .from("offers")
    .select("id, brokerage_id, listing_id, offer_price, presented_to_seller_at")
    .eq("id", offerId)
    .eq("brokerage_id", brokerageId)
    .eq("listing_id", listingId)
    .maybeSingle()
  if (error) return { ok: false, error: error.message }
  if (!data) return { ok: false, error: "Forbidden" }
  return { ok: true, offer: data as OfferForRelease }
}

// ─── RELEASE AN OFFER TO THE SELLER'S PORTAL ─────────────────────────────────

export interface PresentResult {
  success: boolean
  error?: string
  presentedAt?: string | null
  /** False when the approver could not be recorded as an agents-class id. */
  approverRecorded?: boolean
  /** Already-released offers report this instead of raising a second banner. */
  alreadyPresented?: boolean
  /** Non-fatal problems the caller must be shown rather than have swallowed. */
  warnings?: string[]
}

export async function presentOfferToSeller(params: {
  offerId: string
  listingId: string
  note?: string
}): Promise<PresentResult> {
  const { offerId, listingId } = params
  const note = (params.note ?? "").trim().slice(0, 1000) || null

  if (!isValidUUID(offerId) || !isValidUUID(listingId)) {
    return { success: false, error: "Invalid ID" }
  }

  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  const listingResult = await loadListingInCallerBrokerage(listingId, auth.brokerageId)
  if (!listingResult.ok) return { success: false, error: listingResult.error }
  const listing = listingResult.listing

  const offerResult = await loadOfferOnListing(offerId, listingId, auth.brokerageId)
  if (!offerResult.ok) return { success: false, error: offerResult.error }
  const offer = offerResult.offer

  const svc = createServiceClient()
  const warnings: string[] = []

  // users.id -> agents.id. NEVER a `??` across the boundary: a users id written
  // into this column is FK-rejected, and supabase-js resolves a rejected write,
  // so the failure would be invisible.
  const approverAgentId = await resolveAgentId(svc as any, auth.userId)
  if (!approverAgentId) {
    warnings.push(
      "Released, but your account has no agent profile, so the approver could not be recorded. Ask an admin to finish your agent setup.",
    )
  }

  // Idempotent. A second release must not raise a second "you have a new offer"
  // banner; it only refreshes the note the agent attached.
  if (offer.presented_to_seller_at) {
    if (note !== null) {
      const { error: noteErr } = await svc
        .from("offers")
        .update({ seller_presentation_note: note, updated_at: new Date().toISOString() })
        .eq("id", offerId)
        .eq("brokerage_id", auth.brokerageId)
      if (noteErr) return { success: false, error: noteErr.message }
    }
    return {
      success: true,
      alreadyPresented: true,
      presentedAt: offer.presented_to_seller_at,
      approverRecorded: !!approverAgentId,
      warnings,
    }
  }

  const now = new Date().toISOString()
  const stamp = {
    presented_to_seller_at: now,
    presented_to_seller_by_agent_id: approverAgentId,
    seller_presentation_note: note,
    updated_at: now,
  }
  const { data: stamped, error: stampErr } = await svc
    .from("offers")
    .update(stamp)
    .eq("id", offerId)
    .eq("brokerage_id", auth.brokerageId)
    .eq("listing_id", listingId)
    .select("id, presented_to_seller_at")
  if (stampErr) return { success: false, error: stampErr.message }
  if (!stamped || stamped.length === 0) {
    return { success: false, error: "Nothing was released — the offer no longer matches this listing." }
  }

  // R4d — the portal's "you have a new offer" banner. Its activity type had
  // exactly one writer (our own offer wizard), so an offer that arrived by email
  // could never raise it. The release is where that notification belongs.
  //
  // brokerage_id is NOT NULL with no default; entity_id is nullable, so omitting
  // it succeeds INVISIBLY and the row could never be traced back to this offer.
  const sellerContactId = listing.seller_contact_id ?? listing.contact_id ?? null
  if (sellerContactId && listing.brokerage_id) {
    const notification = {
      brokerage_id:  listing.brokerage_id,
      contact_id:    sellerContactId,
      agent_id:      listing.agent_id,
      listing_id:    listing.id,
      entity_type:   "offer",
      entity_id:     offerId,
      activity_type: PORTAL_OFFER_NOTIFICATION,
      title:         "Your agent has an offer ready for you to review",
      description:   `An offer on ${listing.address ?? "your property"} has been reviewed by your agent and is now on your portal with the interactive net sheet.`,
      status:        "pending",
      priority:      "high",
      notes:         JSON.stringify({ offer_id: offerId, listing_id: listing.id, notify_portal: true, released: true }),
    }
    const { error: notifyErr } = await svc.from("activities").insert(notification)
    if (notifyErr) {
      warnings.push(`The offer is now visible to your seller, but their portal alert was not created: ${notifyErr.message}`)
    }
  } else {
    warnings.push("The offer is released, but this listing has no seller contact, so no portal alert was raised.")
  }

  revalidatePath(`/dashboard/listings/${listingId}/offers`)
  if (sellerContactId) revalidatePath(`/portal/${sellerContactId}/offers`)

  return {
    success: true,
    presentedAt: now,
    approverRecorded: !!approverAgentId,
    alreadyPresented: false,
    warnings,
  }
}

// ─── RETRACT A RELEASE ───────────────────────────────────────────────────────

export async function unpresentOfferFromSeller(params: {
  offerId: string
  listingId: string
  reason?: string
}): Promise<PresentResult> {
  const { offerId, listingId } = params
  const reason = (params.reason ?? "").trim().slice(0, 1000)

  if (!isValidUUID(offerId) || !isValidUUID(listingId)) {
    return { success: false, error: "Invalid ID" }
  }

  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  const listingResult = await loadListingInCallerBrokerage(listingId, auth.brokerageId)
  if (!listingResult.ok) return { success: false, error: listingResult.error }
  const listing = listingResult.listing

  const offerResult = await loadOfferOnListing(offerId, listingId, auth.brokerageId)
  if (!offerResult.ok) return { success: false, error: offerResult.error }

  const svc = createServiceClient()
  const warnings: string[] = []
  const now = new Date().toISOString()

  const retraction = {
    presented_to_seller_at: null,
    presented_to_seller_by_agent_id: null,
    seller_presentation_note: reason ? `Retracted: ${reason}` : null,
    updated_at: now,
  }
  const { data: cleared, error: clearErr } = await svc
    .from("offers")
    .update(retraction)
    .eq("id", offerId)
    .eq("brokerage_id", auth.brokerageId)
    .eq("listing_id", listingId)
    .select("id")
  if (clearErr) return { success: false, error: clearErr.message }
  if (!cleared || cleared.length === 0) {
    return { success: false, error: "Nothing was retracted — the offer no longer matches this listing." }
  }

  // The banner this offer raised must go with it; otherwise the seller keeps an
  // alert for an offer that is no longer on their screen.
  const { error: sweepErr } = await svc
    .from("activities")
    .delete()
    .eq("entity_id", offerId)
    .eq("entity_type", "offer")
    .eq("brokerage_id", listing.brokerage_id ?? auth.brokerageId)
    .eq("activity_type", PORTAL_OFFER_NOTIFICATION)
  if (sweepErr) {
    warnings.push(`The offer is hidden again, but the seller's portal alert could not be withdrawn: ${sweepErr.message}`)
  }

  const sellerContactId = listing.seller_contact_id ?? listing.contact_id ?? null
  revalidatePath(`/dashboard/listings/${listingId}/offers`)
  if (sellerContactId) revalidatePath(`/portal/${sellerContactId}/offers`)

  return { success: true, presentedAt: null, warnings }
}

// ─── READ THE PRESENTATION STATE FOR AN AGENT'S OFFER SCREEN ─────────────────
//
// The listing offer manager renders rows loaded by a reader that predates m387,
// so the release stamp is not on them. This is the reader for that state, behind
// the same gate as the writers above.

export async function getOfferPresentationStates(listingId: string): Promise<{
  success: boolean
  error?: string
  states: PresentationState[]
}> {
  if (!isValidUUID(listingId)) return { success: false, error: "Invalid listing ID", states: [] }

  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error, states: [] }

  const listingResult = await loadListingInCallerBrokerage(listingId, auth.brokerageId)
  if (!listingResult.ok) return { success: false, error: listingResult.error, states: [] }

  const svc = createServiceClient()
  const { data, error } = await svc
    .from("offers")
    .select("id, presented_to_seller_at, presented_to_seller_by_agent_id, seller_presentation_note")
    .eq("listing_id", listingId)
    .eq("brokerage_id", auth.brokerageId)
  if (error) return { success: false, error: error.message, states: [] }

  return {
    success: true,
    states: (data ?? []).map((o: any) => ({
      offerId: o.id,
      presentedAt: o.presented_to_seller_at ?? null,
      presentedByAgentId: o.presented_to_seller_by_agent_id ?? null,
      note: o.seller_presentation_note ?? null,
    })),
  }
}
