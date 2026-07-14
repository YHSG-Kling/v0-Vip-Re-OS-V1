import { PortalNlSearch } from "./PortalNlSearch"
import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import Link from "next/link"
import { determinePortalView } from "@/lib/kernel/portal"
import { CollaborativeSearchDashboard } from "@/components/portal/CollaborativeSearchDashboard"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/app/components/ui/card"
import { Button } from "@/app/components/ui/button"
import { Badge } from "@/app/components/ui/badge"
import { Switch } from "@/app/components/ui/switch"
import { ArrowLeft, Search, Bell, Home, Heart, ThumbsDown, MessageSquare, Settings, Filter, DollarSign, Bed, Bath, MapPin } from "lucide-react"
import { SmartSearchWidget } from "@/app/components/forms/SmartSearchWidget"
import { AnalyzeAnyHomeCard } from "./AnalyzeAnyHomeCard"
import { FitBadge } from "@/app/components/portal/FitBadge"
import { SavedSearchControls } from "./SavedSearchControls"

// Personas that support family/collaborative search
const FAMILY_SEARCH_PERSONAS = [
  "first_time_buyer",
  "military_buyer",
  "upsizing",
  "relocating",
  "repeat_buyer",
]

export default async function SearchPage({
  params,
}: {
  params: Promise<{ contactId: string }>
}) {
  const { contactId } = await params
  const supabase = await createClient()

  // Verify buyer portal view
  const portalView = await determinePortalView(supabase, { contactId })
  if (portalView.view !== "buyer") {
    redirect(`/portal/${contactId}`)
  }

  const { data: contact, error: contactError } = await supabase
    .from("contacts")
    .select("id, first_name, last_name, email, contact_persona")
    .eq("id", contactId)
    .single()

  if (!contact || contactError) {
    redirect("/portal?error=contact_not_found")
  }

  // Parallel data fetches
  const [preferencesResult, alertsResult, savedResult, finResult] = await Promise.all([
    // Property preferences — schema uses inferred_* (AI-derived)
    supabase
      .from("property_preferences")
      .select("id, inferred_min_price, inferred_max_price, inferred_beds_min, inferred_baths_min, inferred_zip_codes, inferred_property_types, inferred_must_have_features, inferred_deal_breakers")
      .eq("contact_id", contactId)
      .maybeSingle(),
    // Property alerts — schema stores filters as individual columns (not a
    // criteria_json blob). select the actual columns the UI renders.
    supabase
      .from("property_alerts")
      .select("id, alert_name, is_active, created_at, min_price, max_price, bedrooms_min, bathrooms_min, cities, zip_codes, property_types, frequency, delivery_channels, snoozed_until")
      .eq("contact_id", contactId)
      .order("created_at", { ascending: false }),
    // Saved + dismissed properties live on `saved_properties` (NOT
    // `property_interests` which holds search criteria).
    supabase
      .from("saved_properties")
      .select("id, listing_id, saved_at, notes, dismissed, dismissed_reason, list_price, bedrooms, bathrooms, primary_photo_url, property_address, city, state, ai_match_score, match_reasons")
      .eq("contact_id", contactId)
      .order("saved_at", { ascending: false })
      .limit(40),
    supabase.from("buyer_financial_profiles").select("pre_approval_amount, pre_approval_expires_at").eq("contact_id", contactId).maybeSingle(),
  ])
  const fin = finResult.data as { pre_approval_amount: number | null; pre_approval_expires_at: string | null } | null

  const preferences = preferencesResult.data
  const alerts = alertsResult.data ?? []
  const savedRows = savedResult.data ?? []

  const savedProperties     = savedRows.filter((s: any) => !s.dismissed)
  const dismissedProperties = savedRows.filter((s: any) => s.dismissed)

  const persona = contact.contact_persona || "first_time_buyer"
  const showCollaborativeSearch = FAMILY_SEARCH_PERSONAS.includes(persona)

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <Button variant="ghost" size="sm" className="mb-2" asChild>
          <Link href={`/portal/${contactId}`}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to Dashboard
          </Link>
        </Button>
        <h1 className="text-3xl font-bold">Home Search</h1>
        <p className="text-muted-foreground mt-1">
          Manage your search criteria and saved properties
        </p>
      </div>

      {/* Search Criteria Card */}
      <Card>
        <CardHeader>
          <div className="mb-4"><PortalNlSearch contactId={contactId} /></div>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Filter className="h-5 w-5" />
                Search Criteria
              </CardTitle>
              <CardDescription>Your home search preferences</CardDescription>
            </div>
            <Button variant="outline" size="sm" asChild>
              <Link href={`/portal/${contactId}/messages`}>
                <MessageSquare className="h-4 w-4 mr-2" />
                Update with Agent
              </Link>
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {preferences ? (
            <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
              {/* Price Range */}
              <div className="space-y-1">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <DollarSign className="h-4 w-4" />
                  Price Range
                </div>
                <p className="font-medium">
                  {preferences.inferred_min_price || preferences.inferred_max_price ? (
                    <>
                      ${(preferences.inferred_min_price || 0).toLocaleString()} - ${(preferences.inferred_max_price || 0).toLocaleString() || "Any"}
                    </>
                  ) : (
                    "Not set"
                  )}
                </p>
              </div>

              {/* Bedrooms */}
              <div className="space-y-1">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Bed className="h-4 w-4" />
                  Bedrooms
                </div>
                <p className="font-medium">
                  {preferences.inferred_beds_min ? `${preferences.inferred_beds_min}+` : "Any"}
                </p>
              </div>

              {/* Bathrooms */}
              <div className="space-y-1">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Bath className="h-4 w-4" />
                  Bathrooms
                </div>
                <p className="font-medium">
                  {preferences.inferred_baths_min ? `${preferences.inferred_baths_min}+` : "Any"}
                </p>
              </div>

              {/* Locations */}
              <div className="space-y-1">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <MapPin className="h-4 w-4" />
                  Locations
                </div>
                <p className="font-medium">
                  {preferences.inferred_zip_codes && preferences.inferred_zip_codes.length > 0
                    ? preferences.inferred_zip_codes.slice(0, 3).join(", ") + (preferences.inferred_zip_codes.length > 3 ? ` +${preferences.inferred_zip_codes.length - 3} more` : "")
                    : "Not set"}
                </p>
              </div>

              {/* Must Haves */}
              {preferences.inferred_must_have_features && preferences.inferred_must_have_features.length > 0 && (
                <div className="sm:col-span-2 space-y-2">
                  <p className="text-sm text-muted-foreground">Must Haves</p>
                  <div className="flex flex-wrap gap-2">
                    {preferences.inferred_must_have_features.map((item: string, i: number) => (
                      <Badge key={i} variant="secondary">{item}</Badge>
                    ))}
                  </div>
                </div>
              )}

              {/* Deal Breakers */}
              {preferences.inferred_deal_breakers && preferences.inferred_deal_breakers.length > 0 && (
                <div className="sm:col-span-2 space-y-2">
                  <p className="text-sm text-muted-foreground">Avoid</p>
                  <div className="flex flex-wrap gap-2">
                    {preferences.inferred_deal_breakers.map((item: string, i: number) => (
                      <Badge key={i} variant="outline">{item}</Badge>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="text-center py-8 space-y-4">
              <Search className="h-12 w-12 text-muted-foreground mx-auto" />
              <div>
                <p className="font-medium">No search criteria set yet</p>
                <p className="text-sm text-muted-foreground">
                  Message your agent to set up your home search preferences
                </p>
              </div>
              <Button asChild>
                <Link href={`/portal/${contactId}/messages`}>
                  <MessageSquare className="h-4 w-4 mr-2" />
                  Contact Agent
                </Link>
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Property Alerts Card */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Bell className="h-5 w-5" />
                Property Alerts
              </CardTitle>
              <CardDescription>Get notified when new properties match your criteria</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {alerts.length === 0 ? (
            <div className="text-center py-6">
              <p className="text-sm text-muted-foreground">
                No alerts set up yet. Your agent can create property alerts for you.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {alerts.map((alert: any) => (
                <div
                  key={alert.id}
                  className="flex items-center justify-between p-3 rounded-lg border"
                >
                  <div className="space-y-1">
                    <p className="font-medium">{alert.alert_name}</p>
                    {/* property_alerts stores criteria as individual columns
                        (not a single criteria_json blob); summarize them. */}
                    <p className="text-xs text-muted-foreground">
                      {[
                        (alert.min_price || alert.max_price)
                          ? `$${(alert.min_price ?? 0).toLocaleString()}–$${(alert.max_price ?? 0).toLocaleString()}`
                          : null,
                        alert.bedrooms_min ? `${alert.bedrooms_min}+ bed` : null,
                        alert.bathrooms_min ? `${alert.bathrooms_min}+ bath` : null,
                        alert.cities?.length ? alert.cities.slice(0, 2).join(", ") : null,
                      ].filter(Boolean).join(" · ") || "Custom criteria"}
                    </p>
                  </div>
                  <SavedSearchControls
                    alertId={alert.id}
                    contactId={contactId}
                    frequency={alert.frequency}
                    isActive={alert.is_active}
                    snoozedUntil={alert.snoozed_until ?? null}
                  />
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Analyze ANY address — the whole market, in our app (affordability + value + agent/lender) */}
      <AnalyzeAnyHomeCard
        contactId={contactId}
        preApprovalAmount={fin?.pre_approval_amount ?? null}
        preApprovalExpiresAt={fin?.pre_approval_expires_at ?? null}
      />

      {/* Smart property search — NL query against buyer preferences */}
      <SmartSearchWidget
        contactId={contactId}
        preferences={preferences ?? undefined}
      />

      {/* Saved/Dismissed Properties */}
      <div className="grid gap-6 md:grid-cols-2">
        {/* Saved Properties */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Heart className="h-5 w-5 text-rose-500" />
              Saved ({savedProperties.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            {savedProperties.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">
                No saved properties yet
              </p>
            ) : (
              <div className="space-y-2">
                {savedProperties.slice(0, 5).map((item: any) => (
                  <Link
                    key={item.id}
                    href={`/portal/${contactId}/properties/${item.listing_id}`}
                    className="flex items-center gap-3 p-2 rounded-lg hover:bg-accent transition-colors"
                  >
                    <div className="h-10 w-10 rounded bg-muted flex items-center justify-center shrink-0">
                      {item.primary_photo_url ? (
                        <img
                          src={item.primary_photo_url}
                          alt=""
                          className="h-full w-full object-cover rounded"
                        />
                      ) : (
                        <Home className="h-5 w-5 text-muted-foreground" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium truncate">
                          {item.property_address || "Property"}
                        </p>
                        <FitBadge score={item.ai_match_score} size="xs" />
                      </div>
                      <p className="text-xs text-muted-foreground">
                        ${item.list_price?.toLocaleString() || "N/A"}
                      </p>
                      {Array.isArray(item.match_reasons) && item.match_reasons[0] && (
                        <p className="text-[11px] text-teal-700 italic truncate">✨ {item.match_reasons[0]}</p>
                      )}
                    </div>
                  </Link>
                ))}
                {savedProperties.length > 5 && (
                  <Button variant="ghost" className="w-full" asChild>
                    <Link href={`/portal/${contactId}/properties`}>
                      View all {savedProperties.length} saved
                    </Link>
                  </Button>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Dismissed Properties */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ThumbsDown className="h-5 w-5 text-muted-foreground" />
              Not Interested ({dismissedProperties.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            {dismissedProperties.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">
                No dismissed properties
              </p>
            ) : (
              <div className="space-y-2">
                {dismissedProperties.slice(0, 5).map((item: any) => (
                  <div
                    key={item.id}
                    className="flex items-center gap-3 p-2 rounded-lg opacity-60"
                  >
                    <div className="h-10 w-10 rounded bg-muted flex items-center justify-center shrink-0">
                      <Home className="h-5 w-5 text-muted-foreground" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm truncate">
                        {item.listing?.address || item.listing?.property_address || "Property"}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        ${item.listing?.list_price?.toLocaleString() || "N/A"}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Collaborative Search (for applicable personas) */}
      {showCollaborativeSearch && (
        <div className="pt-4">
          <h2 className="text-xl font-semibold mb-4">Family Search</h2>
          <CollaborativeSearchDashboard contactId={contactId} contactEmail={contact.email || ""} />
        </div>
      )}
    </div>
  )
}
