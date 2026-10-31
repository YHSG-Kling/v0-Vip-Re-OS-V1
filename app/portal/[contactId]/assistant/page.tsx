/**
 * ─────────────────────────────────────────────────────────────────────────────
 * THE BUYER'S OWN ASSISTANT — the surface `handleBuyerVoiceAssistant` was written
 * for and never given.
 *
 * `app/actions/buyer-execution.ts:handleBuyerVoiceAssistant` routes a buyer's
 * question through `lib/buyer-execution/voice-assistant-integration.ts` and answers
 * it out of their OWN deal — where they are in the journey, what happens next,
 * properties, a tour. It was hardened in a previous wave (it used to take both the
 * contact id AND the acting user id off the wire, so anyone could drive it against
 * any contact in any brokerage and forge the audit row), and then left with no
 * caller at all: nothing in the tree invoked it, so the buyer-facing assistant
 * existed only as an endpoint.
 *
 * THE OWNER'S RULING IS WHAT MAKES THIS SAFE, and it is already implemented inside
 * the action: "anytime there is someone using voice, they are not going to know
 * what their id is so there has to be another way to check who the user is."
 * `requireContactAccess(contactId)` establishes BOTH facts from the session — who
 * the caller is, and whether this contact is inside their tenant (from
 * contacts.brokerage_id). It admits the contact THEMSELVES, which is exactly this
 * audience, as well as their same-brokerage staff. This page passes no identity of
 * any kind; the contactId in the URL is the same one every other portal route
 * carries and the action refuses it if it is not the caller's.
 *
 * STILL OWED — AND `test:orphan-routes` DOES NOT CATCH IT, which is worth stating
 * because a green guard here means less than it looks. That sweep counts this route as
 * referenced by WILDCARD COLLISION: template refs like `/portal/lessons/${…}` collapse
 * to segments ["portal", "lessons", "*"], and the third segment's wildcard matches the
 * literal "assistant" in this route. Nothing actually links here. The real entry is one
 * tile in app/portal/[contactId]/buyer-home.tsx beside the existing quick actions
 * (:373-402):
 *   <Link href={`/portal/${contactId}/assistant`}>Ask My Assistant</Link>
 * That file belongs to another lane and the line is reported, not written.
 *
 * TEXT FIRST, MICROPHONE LATER. The intent enum and the transcript are what the
 * action consumes; a browser speech-recognition layer produces the same two fields
 * and can be added over this without changing the server contract. Shipping the
 * typed lane first means the capability is reachable now rather than gated behind
 * a device-permission flow.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { BuyerAssistantClient } from "./buyer-assistant-client"

export const dynamic = "force-dynamic"

export const metadata = {
  title: "Ask your assistant",
  description: "Ask about your purchase and get an answer from your own file",
}

export default async function PortalAssistantPage({
  params,
}: {
  params: Promise<{ contactId: string }>
}) {
  const { contactId } = await params
  const supabase = await createClient()

  // Read only what is rendered. `error` is destructured because supabase-js
  // RESOLVES a refused query — without it an RLS refusal and "no such contact"
  // are the same value, and the portal would greet a stranger by no name instead
  // of turning them away.
  const { data: contact, error } = await supabase
    .from("contacts")
    .select("id, first_name, contact_type, contact_persona")
    .eq("id", contactId)
    .maybeSingle()

  if (error || !contact) {
    redirect("/portal?error=contact_not_found")
  }

  return (
    <BuyerAssistantClient
      contactId={contactId}
      firstName={(contact.first_name as string | null) ?? "there"}
      contactType={(contact.contact_type as string | null) ?? null}
      persona={(contact.contact_persona as string | null) ?? null}
    />
  )
}
