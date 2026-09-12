import { notFound } from "next/navigation"
import { createServiceClient } from "@/lib/supabase/service"
import { FeedbackForm } from "./feedback-form"

/**
 * THE 404 AT THE END OF THE FEEDBACK EMAIL.
 *
 * `app/actions/open-house-automation.ts:sendFeedbackRequestToAttendee` builds
 *
 *     `${NEXT_PUBLIC_APP_URL}/open-house/feedback/${attendeeId}`
 *
 * and mails it to every open-house visitor, and `/api/open-house/request-feedback`
 * exposes that send as a route. **This page did not exist.** Every visitor who
 * tapped the link in that email got a 404, and `submitFeedback` — the complete,
 * tenant-hardened writer that page was supposed to call — sat with no caller at
 * all. Post-event feedback, the whole point of the request, could never be given.
 *
 * CREDENTIAL MODEL: the visitor is anonymous — a contact, not a platform user —
 * and the unguessable attendee id in the emailed URL is the credential. The read
 * below therefore uses the service client for the same reason `submitFeedback`
 * does; RLS on `open_house_attendees` is tenant-scoped and refuses anonymous
 * sessions outright. Only display fields cross into the page; no brokerage_id,
 * no contact id, no agent identity.
 */

export const dynamic = "force-dynamic"

interface Props {
  params: Promise<{ attendeeId: string }>
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export default async function OpenHouseFeedbackPage({ params }: Props) {
  const { attendeeId } = await params
  if (!UUID_RE.test(attendeeId)) notFound()

  const svc = createServiceClient()

  // `error` is read: supabase-js resolves a refused query, and rendering a
  // "visit not found" 404 over a failed read would hide a real outage behind a
  // message that blames the visitor's link.
  const { data: attendee, error } = await svc
    .from("open_house_attendees")
    .select("id, event_id, feedback_collected_at")
    .eq("id", attendeeId)
    .maybeSingle()

  if (error) {
    return (
      <main className="mx-auto max-w-xl p-6">
        <h1 className="text-xl font-semibold">We could not open your feedback form</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Something went wrong on our side — please try the link again in a few minutes.
        </p>
      </main>
    )
  }
  if (!attendee) notFound()

  let propertyAddress: string | null = null
  let eventDate: string | null = null
  if (attendee.event_id) {
    const { data: event } = await svc
      .from("open_house_events")
      .select("event_date, listing:listings(address)")
      .eq("id", attendee.event_id)
      .maybeSingle()
    propertyAddress = ((event as any)?.listing?.address as string | null) ?? null
    eventDate = (event?.event_date as string | null) ?? null
  }

  return (
    <main className="mx-auto max-w-xl p-6 space-y-5">
      <div>
        <h1 className="text-2xl font-bold">How was the open house?</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {propertyAddress
            ? `Your visit to ${propertyAddress}${eventDate ? ` on ${new Date(eventDate).toLocaleDateString()}` : ""}.`
            : "Thanks for visiting — your feedback goes straight to the listing agent."}
        </p>
      </div>

      <FeedbackForm
        attendeeId={attendee.id as string}
        alreadySubmitted={!!attendee.feedback_collected_at}
      />
    </main>
  )
}
