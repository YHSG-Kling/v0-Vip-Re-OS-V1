import { createServiceClient } from "@/lib/supabase/service"
import FeedbackForm from "./feedback-form"

interface Props {
  params: Promise<{ token: string }>
}

export default async function FeedbackPage({ params }: Props) {
  const { token } = await params
  const supabase = createServiceClient()

  // Look up the feedback request by token
  const { data: req } = await supabase
    .from("showing_feedback_requests")
    .select(`
      id,
      showing_id,
      sent_to_email,
      showings!inner (
        id,
        scheduled_at,
        scheduled_date,
        scheduled_time,
        buyer_agent_name,
        listings!inner (
          id,
          address,
          city,
          state
        )
      )
    `)
    .eq("feedback_token", token)
    .maybeSingle()

  // Also check if feedback has already been submitted
  const { data: existingFeedback } = req
    ? await supabase
        .from("showing_feedback")
        .select("presentation_rating")
        .eq("showing_id", req.showing_id)
        .eq("feedback_token", token)
        .maybeSingle()
    : { data: null }

  const alreadySubmitted =
    existingFeedback?.presentation_rating != null

  if (!req) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <div className="max-w-sm text-center">
          <h1 className="mb-2 text-lg font-semibold text-foreground">Link Invalid</h1>
          <p className="text-sm text-muted-foreground">
            This feedback link is invalid or has already been used.
          </p>
        </div>
      </div>
    )
  }

  const showing = (req as any).showings
  const listing = showing?.listings

  const displayDate = showing?.scheduled_at
    ? new Date(showing.scheduled_at).toLocaleDateString("en-US", {
        weekday: "long", month: "long", day: "numeric", year: "numeric",
      })
    : showing?.scheduled_date ?? "your recent showing"

  const propertyAddress = listing
    ? [listing.address, listing.city, listing.state].filter(Boolean).join(", ")
    : "the property"

  return (
    <FeedbackForm
      token={token}
      requestId={req.id}
      showingId={req.showing_id}
      displayDate={displayDate}
      propertyAddress={propertyAddress}
      alreadySubmitted={alreadySubmitted}
    />
  )
}
