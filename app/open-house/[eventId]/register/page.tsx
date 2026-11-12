import { EventRegistrationView } from "./registration-view"

/**
 * THE PLATFORM-ORIGIN REGISTRATION ADDRESS (C22 — wave 148, lane 148H). Since wave 149 (lane 149F, rulings 11 + 12) the canonical
 * address is INSIDE the tenant's own website (app/site/[slug]/events/[eventId]); this one stays for a tenant with no site slug and
 * for links already sent. Both render THE one view (./registration-view.tsx — tenant brand, situation questions, C15 consent).
 */
export default async function EventRegistrationPage({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params
  return <EventRegistrationView eventId={eventId} />
}
