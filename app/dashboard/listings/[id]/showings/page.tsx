import { createClient } from "@/lib/supabase/server"
import { notFound } from "next/navigation"
import {
  resolveShowingMode,
  getShowingRequests,
  getListingShowings,
  getShowingAnalytics,
  getShowingFeedbackCards,
} from "@/app/actions/seller-showings"
import ShowingsClient from "./showings-client"

interface Props {
  params: Promise<{ id: string }>
}

export default async function ShowingsPage({ params }: Props) {
  const { id: listingId } = await params
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) notFound()

  const { data: userRow } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .single()

  const brokerageId = userRow?.brokerage_id
  if (!brokerageId) notFound()

  const { data: listing } = await supabase
    .from("listings")
    .select("id, address, city, state, agent_id, lifecycle_stage, showing_instructions")
    .eq("id", listingId)
    .eq("brokerage_id", brokerageId)
    .single()

  if (!listing) notFound()

  const agentUserId = listing.agent_id ?? user.id

  const [mode, requests, showings, analytics, feedbackCards] = await Promise.all([
    resolveShowingMode({ listingId, agentUserId, brokerageId }),
    getShowingRequests(listingId),
    getListingShowings(listingId),
    getShowingAnalytics(listingId),
    getShowingFeedbackCards(listingId),
  ])

  return (
    <ShowingsClient
      listing={listing}
      brokerageId={brokerageId}
      agentUserId={agentUserId}
      mode={mode}
      initialRequests={requests.requests ?? []}
      initialShowings={showings.showings ?? []}
      analytics={analytics}
      feedbackCards={feedbackCards}
    />
  )
}
