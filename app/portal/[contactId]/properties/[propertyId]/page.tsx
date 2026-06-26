import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { PropertyDetailsView } from "@/components/portal/PropertyDetailsView"
import { PropertyDetailIntelligenceClient } from "./PropertyDetailIntelligenceClient"
import { BuyerOfferToolsCard } from "./BuyerOfferToolsCard"
import { getSmartInsights, isPropertySaved } from "@/app/actions/smart-insights"

export default async function PropertyDetailsPage({
  params,
}: {
  params: Promise<{ contactId: string; propertyId: string }>
}) {
  const { contactId, propertyId } = await params
  const supabase = await createClient()

  // Fetch contact, saved property, showings, insights, and saved status in parallel
  const [
    { data: contact },
    { data: savedProperty },
    { data: showings },
    smartInsights,
    isSaved,
    { data: finProfile },
  ] = await Promise.all([
    supabase.from("contacts").select("*").eq("id", contactId).single(),
    supabase
      .from("saved_properties")
      .select("*")
      .eq("contact_id", contactId)
      .eq("id", propertyId)
      .maybeSingle(),
    supabase
      .from("showing_requests")
      .select("id, status, requested_date")
      .eq("contact_id", contactId)
      .order("created_at", { ascending: false }),
    getSmartInsights(propertyId, contactId).catch(() => null),
    isPropertySaved(contactId, propertyId).catch(() => false),
    supabase.from("buyer_financial_profiles").select("pre_approval_amount, pre_approval_expires_at").eq("contact_id", contactId).maybeSingle(),
  ])

  if (!contact) {
    redirect("/")
  }

  // Build property data object from saved_property row for the intelligence layer
  const propertyData: Record<string, any> = savedProperty
    ? {
        address: savedProperty.property_address,
        price: savedProperty.list_price,
        bedrooms: savedProperty.bedrooms,
        bathrooms: savedProperty.bathrooms,
        sqft: savedProperty.sqft,
        city: savedProperty.city,
        state: savedProperty.state,
        property_type: savedProperty.property_type,
        primary_photo_url: savedProperty.primary_photo_url,
      }
    : {}

  const propertyAddress =
    savedProperty?.property_address ?? propertyId

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-4xl mx-auto px-4 py-6 space-y-6">
        {/* Existing property view — photos, price, beds/baths, etc. */}
        <PropertyDetailsView
          contactId={contactId}
          propertyId={propertyId}
          contact={contact}
          savedProperty={savedProperty}
          showings={showings || []}
        />

        {/* External (RentCast/IDX) saves: stored specs power our tools here; link out for photos. */}
        {!savedProperty?.listing_id && savedProperty?.listing_url && (
          <a
            href={savedProperty.listing_url as string}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center text-sm text-teal-700 underline underline-offset-2"
          >
            View the full listing &amp; photos{savedProperty.source ? ` on ${savedProperty.source}` : ""} →
          </a>
        )}

        {/* Buyer self-serve: affordability + "help me make an offer" → signals the agent */}
        <BuyerOfferToolsCard
          contactId={contactId}
          propertyId={propertyId}
          propertyAddress={propertyAddress}
          price={(propertyData.price as number | null) ?? null}
          preApprovalAmount={(finProfile as { pre_approval_amount: number | null } | null)?.pre_approval_amount ?? null}
          preApprovalExpiresAt={(finProfile as { pre_approval_expires_at: string | null } | null)?.pre_approval_expires_at ?? null}
        />

        {/* AI Intelligence layer */}
        <PropertyDetailIntelligenceClient
          contactId={contactId}
          propertyId={propertyId}
          propertyAddress={propertyAddress}
          propertyData={propertyData}
          initialIsSaved={isSaved as boolean}
          initialInsights={smartInsights}
          showings={(showings ?? []) as any}
        />
      </div>
    </div>
  )
}
