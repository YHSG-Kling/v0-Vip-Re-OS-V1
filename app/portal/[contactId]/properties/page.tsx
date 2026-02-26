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

  // Fetch collaborative searches (family search boards)
  const { data: collaborativeSearches } = await supabase
    .from("collaborative_searches")
    .select(`
      *,
      collaborative_search_members(*),
      collaborative_search_properties(*)
    `)
    .eq("contact_id", contactId)
    .eq("is_active", true)

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

  // Fetch search history for AI recommendations
  const { data: searchHistory } = await supabase
    .from("property_search_log")
    .select("*")
    .eq("contact_id", contactId)
    .order("created_at", { ascending: false })
    .limit(20)

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
      collaborativeSearches={collaborativeSearches || []}
      showings={showings || []}
      offers={offers || []}
      searchHistory={searchHistory || []}
      contactId={contactId}
    />
  )
}
