import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import PersonaPropertiesDashboard from "@/app/components/portal/PersonaPropertiesDashboard"
import { getPersonaConfig } from "@/lib/portal"
import { determinePortalView } from "@/lib/kernel/portal"
import { getRecommendedProperties } from "@/app/actions/ai-client-portal"
import { getBuyerPortalMatches } from "@/app/actions/buyer-portal-matches"
import { TopMatchesPanel } from "@/app/portal/[contactId]/components/TopMatchesPanel"

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
    .order("saved_at", { ascending: false })

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
    .select("id, alert_name, frequency, is_active, created_at, min_price, max_price, bedrooms_min, bathrooms_min, cities")
    .eq("contact_id", contactId)
    .order("created_at", { ascending: false })

  // Saved + dismissed listings — `saved_properties` is the canonical table
  // (NOT `property_interests`, which holds search criteria, not properties).
  const { data: propertyInterests } = await supabase
    .from("saved_properties")
    .select("id, listing_id, property_address, list_price, bedrooms, bathrooms, primary_photo_url, dismissed, dismissed_reason, notes, saved_at")
    .eq("contact_id", contactId)
    .order("saved_at", { ascending: false })

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

  // Determine portal view via kernel gate — buyer vs seller vs lifetime
  const portalView = await determinePortalView(supabase, { contactId })

  // BUYER PATH: Surface the buyer's own smart searches (property_alerts) and
  // inferred preferences (property_preferences). Buyers own their searches —
  // they do NOT browse brokerage listings directly.
  let buyerSmartSearches: Array<{
    id: string
    alert_name: string | null
    bedrooms_min: number | null
    bathrooms_min: number | null
    min_price: number | null
    max_price: number | null
    zip_codes: string[] | null
    cities: string[] | null
    property_types: string[] | null
    frequency: string | null
    is_active: boolean
    last_run_at: string | null
    last_match_count: number | null
  }> = []

  let buyerInferredPrefs: {
    inferred_min_price: number | null
    inferred_max_price: number | null
    inferred_beds_min: number | null
    inferred_baths_min: number | null
    inferred_cities: string[] | null
    inferred_zip_codes: string[] | null
    inferred_property_types: string[] | null
    inferred_must_have_features: string[] | null
    confidence_score: number | null
  } | null = null

  // SELLER PATH: Resolve brokerage-represented listing for this seller contact
  let sellerListing: {
    id: string
    address: string | null
    city: string | null
    state: string | null
    zip: string | null
    list_price: number | null
    bedrooms: number | null
    bathrooms: number | null
    sqft: number | null
    lifecycle_stage: string | null
    status: string | null
    showing_count: number | null
    mls_number: string | null
    listing_date: string | null
  } | null = null

  if (portalView.view === "buyer") {
    // Fetch all active smart searches (property_alerts) for this buyer
    const { data: alerts } = await supabase
      .from("property_alerts")
      .select(
        "id, alert_name, bedrooms_min, bathrooms_min, min_price, max_price, zip_codes, cities, property_types, frequency, is_active, last_run_at, last_match_count"
      )
      .eq("contact_id", contactId)
      .order("created_at", { ascending: false })
      .limit(10)

    buyerSmartSearches = alerts ?? []

    // Fetch AI-inferred preferences from buyer behavior signals
    const { data: prefs } = await supabase
      .from("property_preferences")
      .select(
        "inferred_min_price, inferred_max_price, inferred_beds_min, inferred_baths_min, inferred_cities, inferred_zip_codes, inferred_property_types, inferred_must_have_features, confidence_score"
      )
      .eq("contact_id", contactId)
      .order("last_calculated_at", { ascending: false })
      .limit(1)
      .maybeSingle()

    buyerInferredPrefs = prefs ?? null
  }

  if (portalView.view === "seller" || contact.contact_type === "seller") {
    // Resolve brokerage-represented listing for this seller
    const { data: listing } = await supabase
      .from("listings")
      .select(
        "id, address, city, state, zip, list_price, bedrooms, bathrooms, sqft, lifecycle_stage, status, showing_count, mls_number, listing_date"
      )
      .eq("seller_contact_id", contactId)
      .in("status", ["active", "pending", "coming_soon", "under_contract"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()

    sellerListing = listing ?? null
  }

  // Load AI-recommended properties for buyers only — uses buyer preferences
  // and budget from contacts table to surface matched active listings.
  const recommendedResult = portalView.view === "buyer"
    ? await getRecommendedProperties({ contactId, limit: 6 }).catch(() => ({ success: false, properties: [] }))
    : { success: false, properties: [] }
  const recommendedProperties = recommendedResult.properties ?? []

  // Buyer's cached AI property matches (property_matches upserts). Resolved via
  // the unified property-facts resolver so external-MLS matches surface too.
  // Buyer-only; auth + brokerage ownership are enforced inside the action.
  const topMatchesResult = portalView.view === "buyer"
    ? await getBuyerPortalMatches(contactId, 6).catch(() => ({ success: false, matches: [] }))
    : { success: false, matches: [] }
  const topMatches = topMatchesResult.matches ?? []

  // Parse custom_fields
  const customFields = typeof contact.custom_fields === "string" 
    ? JSON.parse(contact.custom_fields || "{}") 
    : contact.custom_fields || {}

  return (
    <>
      {topMatches.length > 0 && (
        <div className="max-w-6xl mx-auto px-4 pt-6">
          <TopMatchesPanel contactId={contactId} matches={topMatches} />
        </div>
      )}
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
      portalView={portalView.view}
      buyerSmartSearches={buyerSmartSearches}
      buyerInferredPrefs={buyerInferredPrefs}
      sellerListing={sellerListing}
      />
    </>
  )
}
