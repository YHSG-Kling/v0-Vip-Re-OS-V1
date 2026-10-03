import { createClient } from "@/lib/supabase/server"
import { Suspense } from "react"
import PortalSocialHub from "@/components/portal/PortalSocialHub"
import { redirect } from "next/navigation"

export default async function SocialPage({ params }: { params: Promise<{ contactId: string }> }) {
  const { contactId } = await params
  const supabase = await createClient()

  // Fetch contact and their listing.
  //
  // contacts ↔ listings carries TWO FKs (listings_contact_id_fkey,
  // listings_seller_contact_id_fkey), so the bare `listings(*)` was ambiguous and
  // PostgREST refused the ENTIRE request (PGRST201) — supabase-js resolves that, so
  // `contact` was null and this page redirected every seller straight back to "/".
  // Named seller_contact_id: this surface is explicitly seller-facing ("available for
  // sellers with an active listing" below), and seller_contact_id is the column the
  // listing rails actually populate — legacy listings.contact_id is unset in practice.
  // Embed names the columns PortalSocialHub reads (no `*` inside an embed, #214).
  const { data: contact, error: contactError } = await supabase
    .from("contacts")
    .select("*, listings!listings_seller_contact_id_fkey(id, mls_number, address, bedrooms, bathrooms, list_price, property_type, photos, status)")
    .eq("id", contactId)
    .single()

  // Check the error — an unchecked read reports a refusal as an absence, which is
  // exactly what made the ambiguity above look like "this contact doesn't exist".
  if (contactError || !contact) {
    redirect("/")
  }

  // Check if they're a seller with a listing
  const listing = contact.listings?.[0]
  if (!listing) {
    return (
      <div className="text-center py-12">
        <h2 className="text-xl font-semibold mb-2">Social Media Hub</h2>
        <p className="text-muted-foreground">This feature is available for sellers with an active listing.</p>
      </div>
    )
  }

  // Fetch social posts for this listing
  const { data: socialPosts } = await supabase
    .from("social_posts")
    .select("*, social_post_analytics(*)")
    .eq("listing_id", listing.id)
    .order("scheduled_for", { ascending: false })

  // Fetch published posts if no listing-linked posts
  const posts = socialPosts || []

  return (
    <Suspense fallback={<div className="animate-pulse">Loading social hub...</div>}>
      <PortalSocialHub contact={contact} contactId={contactId} listing={listing} socialPosts={posts} />
    </Suspense>
  )
}
