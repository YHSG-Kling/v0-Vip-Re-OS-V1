import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { getListingMedia, getSocialPosts, getVideoProjects, getVideoTemplates, getSocialAccounts } from "@/app/actions/listing-media"
import { MediaManagerClient } from "./media-manager-client"

interface PageProps {
  params: Promise<{ id: string }>
}

export default async function ListingMediaPage({ params }: PageProps) {
  const { id: listingId } = await params

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const { data: profile } = await supabase
    .from("users")
    .select("brokerage_id, role")
    .eq("id", user.id)
    .single()
  if (!profile?.brokerage_id) redirect("/dashboard")

  // Fetch the listing to confirm it exists and get address
  const { data: listing } = await supabase
    .from("listings")
    .select("id, address, lifecycle_stage, status")
    .eq("id", listingId)
    .eq("brokerage_id", profile.brokerage_id)
    .single()
  if (!listing) redirect("/dashboard/listings")

  // Parallel data fetch
  const [mediaResult, videosResult, socialResult, templatesResult, accountsResult] =
    await Promise.all([
      getListingMedia(listingId),
      getVideoProjects(listingId),
      getSocialPosts(listingId),
      getVideoTemplates(),
      getSocialAccounts(profile.brokerage_id),
    ])

  return (
    <MediaManagerClient
      listingId={listingId}
      listing={listing}
      brokerageId={profile.brokerage_id}
      userRole={profile.role}
      initialMedia={mediaResult.data ?? []}
      initialVideos={videosResult.data ?? []}
      initialPosts={socialResult.data ?? []}
      videoTemplates={templatesResult.data ?? []}
      socialAccounts={accountsResult.data ?? []}
    />
  )
}
