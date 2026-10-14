import { notFound } from "next/navigation"
import { getOpenHouseEventPublic } from "@/app/actions/seller-open-house"
import { SignInKiosk } from "./sign-in-kiosk"

/**
 * The public open-house sign-in kiosk.
 *
 * This page used to assemble its own payload from three raw service-client
 * queries. Every one of them was a duplicate of
 * app/actions/seller-open-house.ts:getOpenHouseEventPublic, which was complete
 * and called from nowhere — so the merge went the other way round: the two
 * things the page did that the action did not (resolve the agent for the
 * header, load brokerage branding) were MOVED ONTO the action first, and only
 * then was the inline copy deleted. Three defects went with it:
 *
 *  1. IDENTITY CLASS. `from("users").eq("id", event.agent_id)` — but
 *     open_house_events.agent_id FKs agents(id), a different id space. It
 *     matched nothing on every event, so the kiosk has never shown an agent's
 *     name. The action resolves agents -> agents.user_id -> users.
 *  2. PUBLIC PAYLOAD. The raw listing row (brokerage_id, agent_id) plus the
 *     agent's users.id and email address were serialised into a page anyone at
 *     the open house can view source on. The action returns display fields only.
 *  3. BRANDING SCOPE. Branding is looked up by the EVENT's brokerage_id inside
 *     the action, so a kiosk cannot render another tenant's logo.
 *
 * The action also decides which events may be signed into at all
 * (scheduled | marketing | active — matching what checkInAttendee accepts), so
 * a completed or cancelled event 404s here instead of collecting names for an
 * event that is over.
 */

interface Props {
  params: Promise<{ eventId: string }>
}

export default async function OpenHouseSignInPage({ params }: Props) {
  const { eventId } = await params

  const event = await getOpenHouseEventPublic(eventId)
  if (!event) notFound()

  return <SignInKiosk event={event} />
}
