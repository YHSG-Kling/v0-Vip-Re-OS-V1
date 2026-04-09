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
    .select("id, first_name, last_name, name, email, contact_persona")
    .eq("id", contactId)
    .single()

  if (!contact || contactError) {
    redirect("/portal?error=contact_not_found")
  }

  // Parallel data fetches
  const [preferencesResult, alertsResult, interestsResult] = await Promise.all([
    // Property preferences
    supabase
      .from("property_preferences")
      .select("id, min_price, max_price, min_beds, min_baths, max_beds, max_baths, zip_codes, property_types, must_haves, nice_to_haves")
      .eq("contact_id", contactId)
      .maybeSingle(),
    // Property alerts
    supabase
      .from("property_alerts")
      .select("id, alert_name, criteria_json, is_active, created_at")
      .eq("contact_id", contactId)
      .order("created_at", { ascending: false }),
    // Property interests
    supabase
      .from("property_interests")
      .select("id, listing_id, interest_level, saved_at, notes, listing:listings(id, address, property_address, list_price, bedrooms, bathrooms, primary_photo_url)")
      .eq("contact_id", contactId)
      .order("saved_at", { ascending: false })
      .limit(20),
  ])

  const preferences = preferencesResult.data
  const alerts = alertsResult.data ?? []
  const interests = interestsResult.data ?? []

  // Group interests by level
  const savedProperties = interests.filter((i: any) => i.interest_level === "saved" || i.interest_level === "favorited")
  const dismissedProperties = interests.filter((i: any) => i.interest_level === "dismissed" || i.interest_level === "not_interested")

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
                  {preferences.min_price || preferences.max_price ? (
                    <>
                      ${(preferences.min_price || 0).toLocaleString()} - ${(preferences.max_price || 0).toLocaleString() || "Any"}
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
                  {preferences.min_beds ? `${preferences.min_beds}+` : "Any"}
                  {preferences.max_beds ? ` (max ${preferences.max_beds})` : ""}
                </p>
              </div>

              {/* Bathrooms */}
              <div className="space-y-1">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Bath className="h-4 w-4" />
                  Bathrooms
                </div>
                <p className="font-medium">
                  {preferences.min_baths ? `${preferences.min_baths}+` : "Any"}
                  {preferences.max_baths ? ` (max ${preferences.max_baths})` : ""}
                </p>
              </div>

              {/* Locations */}
              <div className="space-y-1">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <MapPin className="h-4 w-4" />
                  Locations
                </div>
                <p className="font-medium">
                  {preferences.zip_codes && preferences.zip_codes.length > 0
                    ? preferences.zip_codes.slice(0, 3).join(", ") + (preferences.zip_codes.length > 3 ? ` +${preferences.zip_codes.length - 3} more` : "")
                    : "Not set"}
                </p>
              </div>

              {/* Must Haves */}
              {preferences.must_haves && preferences.must_haves.length > 0 && (
                <div className="sm:col-span-2 space-y-2">
                  <p className="text-sm text-muted-foreground">Must Haves</p>
                  <div className="flex flex-wrap gap-2">
                    {preferences.must_haves.map((item: string, i: number) => (
                      <Badge key={i} variant="secondary">{item}</Badge>
                    ))}
                  </div>
                </div>
              )}

              {/* Nice to Haves */}
              {preferences.nice_to_haves && preferences.nice_to_haves.length > 0 && (
                <div className="sm:col-span-2 space-y-2">
                  <p className="text-sm text-muted-foreground">Nice to Haves</p>
                  <div className="flex flex-wrap gap-2">
                    {preferences.nice_to_haves.map((item: string, i: number) => (
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
                    {alert.criteria_json && (
                      <p className="text-xs text-muted-foreground">
                        {typeof alert.criteria_json === "string"
                          ? JSON.parse(alert.criteria_json)?.summary || "Custom criteria"
                          : alert.criteria_json?.summary || "Custom criteria"}
                      </p>
                    )}
                  </div>
                  <Badge variant={alert.is_active ? "default" : "secondary"}>
                    {alert.is_active ? "Active" : "Paused"}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

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
                      {item.listing?.primary_photo_url ? (
                        <img
                          src={item.listing.primary_photo_url}
                          alt=""
                          className="h-full w-full object-cover rounded"
                        />
                      ) : (
                        <Home className="h-5 w-5 text-muted-foreground" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium truncate">
                        {item.listing?.address || item.listing?.property_address || "Property"}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        ${item.listing?.list_price?.toLocaleString() || "N/A"}
                      </p>
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
