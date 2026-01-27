import { createClient } from "@/lib/supabase/server"
import { Suspense } from "react"
import PortalSocialHub from "@/components/portal/PortalSocialHub"
import { redirect } from "next/navigation"

export default async function SocialPage({ params }: { params: Promise<{ contactId: string }> }) {
  const { contactId } = await params
  const supabase = await createClient()

  // Fetch contact and their listing
  const { data: contact } = await supabase.from("contacts").select("*, listings(*)").eq("id", contactId).single()

  if (!contact) {
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
    .eq("linked_listing_id", listing.id)
    .order("scheduled_for", { ascending: false })

  // Fetch published posts if no listing-linked posts
  const posts = socialPosts || []

  return (
    <Suspense fallback={<div className="animate-pulse">Loading social hub...</div>}>
      <PortalSocialHub contact={contact} contactId={contactId} listing={listing} socialPosts={posts} />
    </Suspense>
  )
}
