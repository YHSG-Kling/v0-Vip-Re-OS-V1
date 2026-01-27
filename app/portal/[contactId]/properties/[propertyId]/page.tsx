import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { PropertyDetailsView } from "@/components/portal/PropertyDetailsView"

export default async function PropertyDetailsPage({
  params,
}: {
  params: Promise<{ contactId: string; propertyId: string }>
}) {
  const { contactId, propertyId } = await params
  const supabase = await createClient()

  // Fetch contact info
  const { data: contact } = await supabase
    .from("contacts")
    .select("*")
    .eq("id", contactId)
    .single()

  if (!contact) {
    redirect("/")
  }

  // Fetch property from saved properties or search results
  // Note: saved_properties uses 'id' as UUID and 'mls_number' for property identification
  const { data: savedProperty } = await supabase
    .from("saved_properties")
    .select("*")
    .eq("contact_id", contactId)
    .eq("id", propertyId)
    .maybeSingle()

  // Get showing requests for this property
  const { data: showings } = await supabase
    .from("showing_requests")
    .select("*")
    .eq("contact_id", contactId)
    .eq("property_id", propertyId)

  return (
    <PropertyDetailsView
      contactId={contactId}
      propertyId={propertyId}
      contact={contact}
      savedProperty={savedProperty}
      showings={showings || []}
    />
  )
}
