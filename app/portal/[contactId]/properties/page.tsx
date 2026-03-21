import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import PersonaPropertiesDashboard from "@/components/portal/PersonaPropertiesDashboard"
import { getPersonaConfig } from "@/lib/portal"

export default async function PropertiesPage({ params }: { params: Promise<{ contactId: string }> }) {
  const { contactId } = await params
  const supabase = await createClient()

  // Fetch contact with all details
  const { data: contact } = await supabase.from("contacts").select("*").eq("id", contactId).single()

  if (!contact) {
    redirect("/")
  }

  // Get persona config for personalization
  const persona = contact.contact_persona || contact.persona || "first_time_buyer"
  const personaConfig = getPersonaConfig(persona)

  // Fetch saved properties
  const { data: savedProperties } = await supabase
    .from("saved_properties")
    .select("*")
    .eq("contact_id", contactId)
    .order("created_at", { ascending: false })

  // Fetch showing requests
  const { data: showings } = await supabase
    .from("showing_requests")
    .select("*")
    .eq("contact_id", contactId)
    .order("created_at", { ascending: false })

  // Fetch offers
  const { data: offers } = await supabase
    .from("offers")
    .select("*")
    .eq("contact_id", contactId)
    .order("created_at", { ascending: false })

  // Fetch property alerts
  const { data: propertyAlerts } = await supabase
    .from("property_alerts")
    .select("id, search_criteria, frequency, is_active, created_at")
    .eq("contact_id", contactId)
    .order("created_at", { ascending: false })

  // Fetch property interests
  const { data: propertyInterests } = await supabase
    .from("property_interests")
    .select("id, property_address, interest_level, notes, created_at")
    .eq("contact_id", contactId)
    .order("created_at", { ascending: false })

  // Fetch coming soon listings delivered to this buyer via property alerts
  const { data: comingSoonAlertResults } = await supabase
    .from("property_alert_results")
    .select(
      "id, property_address, city, state, zip, list_price, bedrooms, bathrooms, sqft, primary_photo_url, listing_url, mls_status, listed_at, contact_id"
    )
    .eq("contact_id", contactId)
    .eq("mls_status", "coming_soon")
    .order("created_at", { ascending: false })
    .limit(12)

  // Parse custom_fields
  const customFields = typeof contact.custom_fields === "string" 
    ? JSON.parse(contact.custom_fields || "{}") 
    : contact.custom_fields || {}

  return (
    <PersonaPropertiesDashboard
      contact={contact}
      customFields={customFields}
      persona={persona}
      personaConfig={personaConfig}
      savedProperties={savedProperties || []}
      showings={showings || []}
      offers={offers || []}
      propertyAlerts={propertyAlerts || []}
      propertyInterests={propertyInterests || []}
      contactId={contactId}
      comingSoonListings={comingSoonAlertResults || []}
    />
  )
}
