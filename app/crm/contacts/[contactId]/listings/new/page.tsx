import { redirect }      from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { NewListingPageClient } from "./new-listing-page-client"

interface Props {
  params:       Promise<{ contactId: string }>
  searchParams: Promise<{
    /** When set, FormWizard mounts with the AI-staged listing packet preloaded
     *  (voice → stage_listing_packet → email → review here). */
    documentId?: string
  }>
}

export default async function NewListingForContactPage({ params, searchParams }: Props) {
  const { contactId } = await params
  const { documentId } = await searchParams

  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const { data: profile } = await supabase
    .from("users")
    .select("brokerage_id, first_name, last_name, email")
    .eq("id", user.id)
    .single()
  if (!profile?.brokerage_id) redirect("/dashboard")

  // Load seller contact (full row — FormWizard accepts the canonical Contact shape)
  const { data: contact } = await supabase
    .from("contacts")
    .select("*")
    .eq("id", contactId)
    .eq("brokerage_id", profile.brokerage_id)
    .single()
  if (!contact) redirect("/crm/contacts")

  const sellerName = [contact.first_name, contact.last_name].filter(Boolean).join(" ")

  return (
    <NewListingPageClient
      contactId={contactId}
      brokerageId={profile.brokerage_id}
      agentUserId={user.id}
      agentName={[profile.first_name, profile.last_name].filter(Boolean).join(" ")}
      agentEmail={profile.email ?? ""}
      sellerName={sellerName}
      contactFull={contact as any}
      documentId={documentId ?? null}
    />
  )
}
