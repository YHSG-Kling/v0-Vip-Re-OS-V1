import { redirect }          from "next/navigation"
import { createClient }       from "@/lib/supabase/server"
import { startOfferDraft }    from "@/app/actions/buyer-offers"
import { NewOfferPageClient } from "./new-offer-page-client"

interface Props {
  params:      Promise<{ id: string }>
  searchParams: Promise<{
    listingId?:       string
    firstName?:       string
    lastName?:        string
    email?:           string
    phone?:           string
    propertyAddress?: string
  }>
}

export default async function NewOfferPage({ params, searchParams }: Props) {
  const { id: contactId }    = await params
  const {
    listingId,
    firstName:       prefillFirstName,
    lastName:        prefillLastName,
    email:           prefillEmail,
    phone:           prefillPhone,
    propertyAddress: prefillAddress,
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

  // Load contact for display name + email
  const { data: contact } = await supabase
    .from("contacts")
    .select("id, first_name, last_name, email, phone, brokerage_id")
    .eq("id", contactId)
    .eq("brokerage_id", profile.brokerage_id)
    .single()

  if (!contact) redirect(`/dashboard/buyers`)

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
      prefillListingId={listingId ?? null}
      prefillAddress={prefillAddress ?? null}
      prefillPhone={prefillPhone ?? contact.phone ?? null}
    />
  )
}
