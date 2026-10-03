import { notFound } from "next/navigation"
import { createServiceClient } from "@/lib/supabase/service"
import { RsvpButtons } from "./rsvp-buttons"

/**
 * The public RSVP landing page for an open-house invitation.
 *
 * `app/actions/open-house-automation.ts:handleRSVP` is a complete, hardened
 * writer — it verifies the invitation belongs to the event named in the link,
 * refuses a zero-row update rather than thanking the invitee for an RSVP that
 * never landed, and stamps the tenant on the tracking row so it is not written
 * world-open. It had no caller and no page: `inviteContacts` mails an
 * AI-written invitation and never includes a link, so an invitee had no way to
 * answer and `open_house_invitations.rsvp_response` — which the listing's
 * Marketing tab reads and reports on — stayed permanently NULL for everyone.
 *
 * CREDENTIAL MODEL: the invitee is anonymous. The unguessable PAIR
 * (eventId, invitationId) is the credential, and `handleRSVP` re-checks that the
 * invitation really belongs to that event, so holding one id is not enough.
 * The read below uses the service client for the same reason the action does —
 * the tenant RLS policy on `open_house_invitations` refuses anonymous sessions,
 * which is why an RSVP could never previously have been recorded.
 *
 * REMAINING WORK (not done here): `inviteContacts` still does not put this URL
 * in the invitation it sends. The link is
 * `${NEXT_PUBLIC_APP_URL}/open-house/${eventId}/rsvp/${invitationId}` and it has
 * to be appended after the invitation row exists (the id is minted by that
 * insert), i.e. between the staged insert and the `sendOpenHouseInvitation`
 * call, in both the personalized email body and the SMS.
 */

export const dynamic = "force-dynamic"

interface Props {
  params: Promise<{ eventId: string; invitationId: string }>
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export default async function OpenHouseRsvpPage({ params }: Props) {
  const { eventId, invitationId } = await params
  if (!UUID_RE.test(eventId) || !UUID_RE.test(invitationId)) notFound()

  const svc = createServiceClient()

  const { data: invitation, error } = await svc
    .from("open_house_invitations")
    .select("id, event_id, rsvp_response")
    .eq("id", invitationId)
    .maybeSingle()

  if (error) {
    return (
      <main className="mx-auto max-w-xl p-6">
        <h1 className="text-xl font-semibold">We could not open your invitation</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Something went wrong on our side — please try the link again in a few minutes.
        </p>
      </main>
    )
  }
  // Both halves of the credential must agree before anything about the event is
  // shown; a valid invitation id paired with someone else's event id is a 404.
  if (!invitation || invitation.event_id !== eventId) notFound()

  const { data: event } = await svc
    .from("open_house_events")
    .select("event_date, start_time, end_time, listing:listings(address, city, state)")
    .eq("id", eventId)
    .maybeSingle()

  const listing = (event as any)?.listing ?? null
  const address = listing
    ? [listing.address, listing.city, listing.state].filter(Boolean).join(", ")
    : null

  return (
    <main className="mx-auto max-w-xl p-6 space-y-5">
      <div>
        <h1 className="text-2xl font-bold">You&apos;re invited to an open house</h1>
        {address && <p className="mt-1 text-sm text-muted-foreground">{address}</p>}
        {event?.event_date && (
          <p className="text-sm text-muted-foreground">
            {new Date(event.event_date as string).toLocaleDateString(undefined, {
              weekday: "long", month: "long", day: "numeric",
            })}
            {event.start_time ? ` · ${event.start_time}` : ""}
            {event.end_time ? `–${event.end_time}` : ""}
          </p>
        )}
      </div>

      <RsvpButtons
        eventId={eventId}
        invitationId={invitationId}
        existingResponse={(invitation.rsvp_response as string | null) ?? null}
      />
    </main>
  )
}
