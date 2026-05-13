import { redirect }                from "next/navigation"
import { createClient }           from "@/lib/supabase/server"
import { startOfferDraft }        from "@/app/actions/buyer-offers"
import { canBuyerSubmitOffers }   from "@/app/actions/buyer-lifecycle-core"
import { NewOfferPageClient }     from "./new-offer-page-client"

interface Props {
  params:      Promise<{ contactId: string }>
  searchParams: Promise<{
    listingId?:       string
    firstName?:       string
    lastName?:        string
    email?:           string
    phone?:           string
    propertyAddress?: string
    /** When set, the page mounts the canonical FormWizard with the staged
     *  packet preloaded (AI-staged from voice intake). Without it, the
     *  agent goes through the regular OfferInitiationFlow. */
    documentId?:      string
  }>
}

export default async function NewOfferPage({ params, searchParams }: Props) {
  const { contactId }    = await params
  const {
    listingId,
    firstName:       prefillFirstName,
    lastName:        prefillLastName,
    email:           prefillEmail,
    phone:           prefillPhone,
    propertyAddress: prefillAddress,
    documentId,
  }                          = await searchParams

  const supabase = await createClient()

  // Auth guard
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  // Load agent profile for brokerage_id
  const { data: profile } = await supabase
    .from("users")
    .select("brokerage_id, first_name, last_name, role")
    .eq("id", user.id)
    .single()

  if (!profile?.brokerage_id) redirect("/dashboard")

  // Load contact (full row — FormWizard requires the canonical Contact shape)
  const { data: contact } = await supabase
    .from("contacts")
    .select("*")
    .eq("id", contactId)
    .eq("brokerage_id", profile.brokerage_id)
    .single()

  if (!contact) redirect(`/dashboard/buyers`)

  // Server-side gate: reject direct URL navigation for locked buyers
  const offerGate = await canBuyerSubmitOffers(contactId)
  if (!offerGate.allowed) {
    redirect(`/contacts/${contactId}/offers`)
  }

  // Emit kernel event: buyer.offer.draft_started
  await startOfferDraft({
    contactId,
    brokerageId: profile.brokerage_id,
    agentUserId: user.id,
    listingId:   listingId ?? null,
  })

  const contactName = [contact.first_name, contact.last_name].filter(Boolean).join(" ")

  return (
    <NewOfferPageClient
      contactId={contactId}
      brokerageId={profile.brokerage_id}
      agentUserId={user.id}
      contactName={contactName}
      contactEmail={contact.email ?? ""}
      contactFull={contact as any}
      prefillListingId={listingId ?? null}
      prefillAddress={prefillAddress ?? null}
      prefillPhone={prefillPhone ?? contact.phone ?? null}
      documentId={documentId ?? null}
    />
  )
}
