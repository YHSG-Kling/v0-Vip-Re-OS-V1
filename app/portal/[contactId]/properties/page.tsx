import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import PersonaPropertiesDashboard from "@/app/components/portal/PersonaPropertiesDashboard"
import { getPersonaConfig } from "@/lib/portal"
import { getRecommendedProperties } from "@/app/actions/ai-client-portal"

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

  // Fetch coming soon listings from the brokerage — these are agent-managed listings
  // not yet on the MLS, surfaced to buyers as an exclusive preview
  const { data: comingSoonAlertResults } = contact.brokerage_id
    ? await supabase
        .from("listings")
        .select("id, address, city, state, zip, list_price, bedrooms, bathrooms, sqft, lifecycle_stage, created_at")
        .eq("brokerage_id", contact.brokerage_id)
        .in("lifecycle_stage", ["COMING_SOON_PREP", "COMING_SOON_ACTIVE"])
        .order("created_at", { ascending: false })
        .limit(6)
    : { data: [] }

  // Fetch AI-recommended properties based on contact preferences
  const recommendedResult = await getRecommendedProperties({ contactId, limit: 6 }).catch(() => ({ success: false, properties: [] }))
  const recommendedProperties = recommendedResult.properties ?? []

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
      recommendedProperties={recommendedProperties}
    />
  )
}
