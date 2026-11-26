"use server"

/**
 * PUSH LISTING TO SELLER PORTAL
 *
 * Agent clicks "Push to Seller Portal" on the listing detail. We:
 *   1. Resolve the public landing URL (`/listing/[slug]`)
 *   2. Generate one-click share copy for each major platform (FB, IG, LI, X,
 *      Nextdoor, iMessage)
 *   3. Insert into seller_share_feed (the seller portal's "Share My Home"
 *      surface that already exists / will exist)
 *   4. Notify the seller in their portal
 *
 * This makes the seller a marketing channel — their friends often want to
 * live near them, generating built-in viral distribution.
 */

import { bestEffort } from "@/lib/db/best-effort"
import { revalidatePath } from "next/cache"
import { requireCallerTenant } from "@/lib/auth/require-caller"
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"

interface Input {
  listingId: string
  brokerageId: string
  userId: string
  message?: string
}

export async function pushListingToSellerPortal(
  input: Input
): Promise<{ success: boolean; publicUrl?: string; error?: string }> {
  // WAVE 155 (lane 155S2): THE GATE. This public endpoint resolved no session: the tenant was `input.brokerageId`, the
  // pusher was `input.userId`, and a seller notification was written for any listing whose brokerage matched the BODY.
  // Now: the SESSION's tenant (a body brokerageId naming another tenant is refused — requireCallerTenant →
  // decideClaimedTenant); the pusher is the SESSION user (a body userId naming someone else is refused); the listing is
  // read INSIDE the session tenant and must be the caller's own listing or the caller must hold the tenant roster.
  const caller = await requireCallerTenant(input.brokerageId)
  if (!caller.ok) return { success: false, error: caller.error }
  if (input.userId && input.userId !== caller.userId) return { success: false, error: "Forbidden: you push listings as yourself" }
  const brokerageId = caller.brokerageId
  const supabase = caller.supabase

  // 1. Fetch listing + slug — inside the session's tenant
  const { data: listing, error: listingError } = await supabase
    .from("listings")
    .select("id, brokerage_id, agent_id, address, city, state, list_price, slug, contact_id")
    .eq("id", input.listingId)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()

  if (listingError) return { success: false, error: "Could not read that listing" }
  if (!listing) return { success: false, error: "Listing not found" }
  if (!isAdminOrBroker({ user_type: caller.userType })) {
    const { data: own, error: ownError } = await supabase.from("agents").select("id").eq("user_id", caller.userId).maybeSingle()
    if (ownError) return { success: false, error: "Could not resolve your agent record" }
    if (!own || (own as { id: string }).id !== (listing as { agent_id?: string | null }).agent_id) {
      return { success: false, error: "Only the listing's agent or brokerage staff can push it to the seller" }
    }
  }

  // G12 receipt (agent_action_ledger): who pushed which listing to its seller's portal. No idempotency key — a second push
  // is a second, real push (fresh copy + a fresh bell).
  const { ledgerSessionAction } = await import("@/lib/kernel/action-ledger")
  const pushed = await ledgerSessionAction<{ success: boolean; publicUrl?: string; error?: string }>({ brokerageId, action: "listing.seller_share.push", actor: { type: "user", userId: caller.userId }, subject: { type: "listing", id: input.listingId }, riskClass: "COMMUNICATION", reasonCode: "HUMAN_REQUESTED" }, async () => {

  const l = listing as {
    id: string
    address: string | null
    city: string | null
    state: string | null
    list_price: number | null
    slug: string | null
    contact_id: string | null
  }

  if (!l.slug) {
    return { success: false, error: "Listing has no public slug — generate one first" }
  }

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? ""
  const publicUrl = `${baseUrl}/listing/${l.slug}`

  // 2. Compose per-platform share copy
  const priceLabel = l.list_price ? `$${l.list_price.toLocaleString()}` : ""
  const headline = `${l.address ?? "Our home"} is for sale${priceLabel ? ` — ${priceLabel}` : ""}`
  const messages = {
    facebook: `${headline}\n\nKnow someone who'd love this neighborhood? Share away! 🏡\n\n${publicUrl}`,
    instagram: `${headline} 🏡\n\nLink in bio or DM for details.`,
    linkedin: `${headline}\n\nIf you know anyone exploring ${l.city ? `${l.city} ` : ""}or thinking about a move, this could be it.\n\n${publicUrl}`,
    twitter: `${headline}\n\n${publicUrl}`,
    nextdoor: `Hi neighbors — ${headline}. Know someone who'd love to call this neighborhood home? Send them our way!\n\n${publicUrl}`,
    imessage: `Hey — putting our place on the market! ${publicUrl}\n\nIf you know anyone who might be interested, would love a share.`,
  }

  // 3. Insert into seller_share_feed (best-effort — table may not exist yet)
  try {
    await bestEffort(supabase.from("seller_share_feed").insert({
      listing_id: l.id,
      contact_id: l.contact_id,
      brokerage_id: brokerageId,
      pushed_by_user_id: caller.userId,
      public_url: publicUrl,
      share_messages: messages,
      agent_note: input.message ?? null,
      pushed_at: new Date().toISOString(),
    }), "analytics/cache/annotation row: its loss does not change what the caller reports — logged, never silent")
  } catch {
    // Table doesn't exist yet — fall through and just notify the seller
  }

  // 4. Notify the seller in their portal
  if (l.contact_id) {
    const { data: contactUser } = await supabase
      .from("contacts")
      .select("contact_user_id")
      .eq("id", l.contact_id)
      .eq("brokerage_id", brokerageId)
      .maybeSingle()
    if (contactUser?.contact_user_id) {
      const { error: notifyError } = await supabase.from("notifications").insert({
        user_id: contactUser.contact_user_id,
        brokerage_id: brokerageId,
        type: "share_my_home",
        title: "Share Your Home",
        body: `Your agent pushed shareable copy + a link for ${l.address ?? "your listing"}. Open your portal to share with friends and family.`,
        entity_type: "listing",
        entity_id: l.id,
        priority: "medium",
        is_read: false,
        created_at: new Date().toISOString(),
      })
      if (notifyError) console.warn("[push-listing-to-seller-portal.ts] notifications insert refused — the bell will not ring:", notifyError.message)
    }
  }

  revalidatePath(`/dashboard/listings/${l.id}`)
  return { success: true, publicUrl }
  })
  return pushed
}
