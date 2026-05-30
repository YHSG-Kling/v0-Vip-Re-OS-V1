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

import { createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"

interface Input {
  listingId: string
  brokerageId: string
  userId: string
  message?: string
}

export async function pushListingToSellerPortal(
  input: Input
): Promise<{ success: boolean; publicUrl?: string; error?: string }> {
  const supabase = await createClient()

  // 1. Fetch listing + slug
  const { data: listing } = await supabase
    .from("listings")
    .select("id, brokerage_id, address, city, state, list_price, slug, contact_id")
    .eq("id", input.listingId)
    .maybeSingle()

  if (!listing) return { success: false, error: "Listing not found" }
  if ((listing as { brokerage_id: string }).brokerage_id !== input.brokerageId) {
    return { success: false, error: "Listing does not belong to this brokerage" }
  }

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
    await supabase.from("seller_share_feed").insert({
      listing_id: l.id,
      contact_id: l.contact_id,
      brokerage_id: input.brokerageId,
      pushed_by_user_id: input.userId,
      public_url: publicUrl,
      share_messages: messages,
      agent_note: input.message ?? null,
      pushed_at: new Date().toISOString(),
    })
  } catch {
    // Table doesn't exist yet — fall through and just notify the seller
  }

  // 4. Notify the seller in their portal
  if (l.contact_id) {
    const { data: contactUser } = await supabase
      .from("contacts")
      .select("contact_user_id")
      .eq("id", l.contact_id)
      .maybeSingle()
    if (contactUser?.contact_user_id) {
      await supabase.from("notifications").insert({
        user_id: contactUser.contact_user_id,
        brokerage_id: input.brokerageId,
        type: "share_my_home",
        title: "Share Your Home",
        body: `Your agent pushed shareable copy + a link for ${l.address ?? "your listing"}. Open your portal to share with friends and family.`,
        entity_type: "listing",
        entity_id: l.id,
        priority: "normal",
        is_read: false,
        created_at: new Date().toISOString(),
      })
    }
  }

  revalidatePath(`/dashboard/listings/${l.id}`)
  return { success: true, publicUrl }
}
