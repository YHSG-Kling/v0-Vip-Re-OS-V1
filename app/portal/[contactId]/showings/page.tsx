import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import Link from "next/link"
import { determinePortalView } from "@/lib/kernel/portal"
import { ShowingsManager } from "@/components/portal/ShowingsManager"
import { Card, CardContent, CardHeader, CardTitle } from "@/app/components/ui/card"
import { Button } from "@/app/components/ui/button"
import { Badge } from "@/app/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/app/components/ui/tabs"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/app/components/ui/collapsible"
import { ArrowLeft, Calendar, Eye, Clock, CheckCircle, XCircle, MapPin, Home, MessageSquare, Star, ChevronDown, Route, Sparkles } from "lucide-react"
import { cn } from "@/lib/utils"
import { BuyerTourCard } from "./components/buyer-tour-card"
import { getPortalBuyerTours } from "@/app/actions/portal-tours"

// Status config
const STATUS_CONFIG: Record<string, { label: string; color: string; icon: any }> = {
  pending: { label: "Pending", color: "bg-amber-100 text-amber-800", icon: Clock },
  approved: { label: "Approved", color: "bg-blue-100 text-blue-800", icon: CheckCircle },
  confirmed: { label: "Confirmed", color: "bg-blue-100 text-blue-800", icon: CheckCircle },
  completed: { label: "Completed", color: "bg-green-100 text-green-800", icon: CheckCircle },
  cancelled: { label: "Cancelled", color: "bg-red-100 text-red-800", icon: XCircle },
  denied: { label: "Denied", color: "bg-red-100 text-red-800", icon: XCircle },
  needs_reschedule: { label: "Needs Reschedule", color: "bg-purple-100 text-purple-800", icon: Calendar },
  rescheduled: { label: "Rescheduled", color: "bg-purple-100 text-purple-800", icon: Calendar },
  planned: { label: "Planned", color: "bg-slate-100 text-slate-800", icon: Calendar },
}

// Interest level config for tour stops
const INTEREST_LEVEL_CONFIG: Record<string, { label: string; color: string }> = {
  love_it: { label: "Love It", color: "bg-green-100 text-green-800" },
  like_it: { label: "Like It", color: "bg-blue-100 text-blue-800" },
  maybe: { label: "Maybe", color: "bg-amber-100 text-amber-800" },
  no: { label: "Not For Us", color: "bg-slate-100 text-slate-600" },
}

export default async function ShowingsPage({
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
    .select("id, first_name, last_name")
    .eq("id", contactId)
    .single()

  if (!contact || contactError) {
    redirect("/portal?error=contact_not_found")
  }

  // Fetch tours with tour_stops, showings, and showing_requests in parallel.
  //
  // Tours go through getPortalBuyerTours (app/actions/portal-tours.ts) — the
  // requireContactAccess-gated service read scoped to THIS contact's rows.
  // Reading `tours` with the RLS client here always returned [] for a real
  // buyer: the live policies on tours are agent-own + broker/admin only, so
  // the contact seat's read was silently refused and the buyer never saw the
  // itinerary their agent "sent to the portal". The gated reader intentionally
  // OMITS listing_agent_* fields and per-stop access codes: the buyer is
  // represented by their agent and must not see other-brokerage contact info
  // (tour-confirm-tab is the only surface for those).
  const [toursResult, showingsResult, requestsResult] = await Promise.all([
    getPortalBuyerTours(contactId),
    // Showings - use scheduled_at column
    supabase
      .from("showings")
      .select("id, listing_id, scheduled_at, status, feedback, notes, rating, buyer_interest_level, listing:listings(id, address, list_price, bedrooms, bathrooms, primary_photo_url)")
      .eq("contact_id", contactId)
      .order("scheduled_at", { ascending: false }),
    // Showing requests - use correct columns
    supabase
      .from("showing_requests")
      .select("id, listing_id, requested_date, requested_start_time, requested_end_time, seller_approved_at, status, message, listing:listings(id, address, list_price, bedrooms, bathrooms, primary_photo_url)")
      .eq("contact_id", contactId)
      .order("requested_date", { ascending: false }),
  ])

  const tours = toursResult.success ? toursResult.tours : []
  const showings = showingsResult.data ?? []
  const requests = requestsResult.data ?? []

  // Combine and categorize showings/requests
  const now = new Date()
  const allItems = [
    ...showings.map((s: any) => ({
      ...s,
      type: "showing" as const,
      date: s.scheduled_at,
    })),
    ...requests.map((r: any) => ({
      ...r,
      type: "request" as const,
      // Combine date and time for display
      date: r.seller_approved_at
        ? new Date(`${r.requested_date}T${r.requested_start_time}`)
        : new Date(r.requested_date),
    })),
  ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())

  const upcomingItems = allItems.filter(
    (item) => new Date(item.date) >= now && !["cancelled", "completed", "denied"].includes(item.status)
  ).sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())

  const completedItems = allItems.filter(
    (item) => item.status === "completed" || (new Date(item.date) < now && !["cancelled", "denied"].includes(item.status))
  )

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <Button variant="ghost" size="sm" className="mb-2" asChild>
            <Link href={`/portal/${contactId}`}>
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back to Dashboard
            </Link>
          </Button>
          <h1 className="text-3xl font-bold">My Tours</h1>
          <p className="text-muted-foreground mt-1">Schedule property tours and share your feedback</p>
        </div>
        <Button asChild>
          <Link href={`/portal/${contactId}/messages`}>
            <Calendar className="h-4 w-4 mr-2" />
            Schedule Tour
          </Link>
        </Button>
      </div>

      {/* Upcoming approved/scheduling tour — surfaced prominently. Only shown
          when the agent has either confirmed the tour OR explicitly sent the
          report (report_sent_at). Drafts in 'planned' state are hidden so the
          buyer doesn't see incomplete plans. */}
      {(() => {
        const today = new Date(); today.setHours(0,0,0,0)
        const upcoming = (tours as any[]).find(t =>
          t.tour_date &&
          new Date(t.tour_date) >= today &&
          (t.status === 'confirmed' || t.status === 'scheduling') &&
          (t.report_sent_at || t.status === 'confirmed')
        )
        return upcoming ? <BuyerTourCard tour={upcoming as any} /> : null
      })()}

      {/* Refusal reported as a refusal — an unreadable tour list must not
          render as "no tours planned". */}
      {!toursResult.success && (
        <Card>
          <CardContent className="py-4 text-center">
            <p className="text-sm text-muted-foreground">
              Your tour itinerary could not be loaded right now. Please refresh, or message your agent.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Planned Tours Section */}
      {tours.length > 0 && (
        <div className="space-y-4">
          <h2 className="text-xl font-semibold flex items-center gap-2">
            <Route className="h-5 w-5" />
            Planned Tours
          </h2>
          <div className="space-y-3">
            {tours.map((tour: any) => (
              <TourCard key={tour.id} tour={tour} contactId={contactId} />
            ))}
          </div>
        </div>
      )}

      {/* Tabs for individual showings */}
      <Tabs defaultValue="upcoming" className="space-y-4">
        <div className="overflow-x-auto -mx-4 sm:mx-0 px-4 sm:px-0">
          <TabsList className="flex min-w-max sm:w-full">
            <TabsTrigger value="upcoming" className="min-h-[44px] flex-1">Upcoming ({upcomingItems.length})</TabsTrigger>
            <TabsTrigger value="completed" className="min-h-[44px] flex-1">Completed ({completedItems.length})</TabsTrigger>
            <TabsTrigger value="all" className="min-h-[44px] flex-1">All ({allItems.length})</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="upcoming" className="space-y-4">
          {upcomingItems.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center">
                <Eye className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
                <h3 className="text-lg font-semibold mb-2">No upcoming tours scheduled</h3>
                <p className="text-muted-foreground mb-4">
                  Find a property you like and schedule a tour
                </p>
                <Button asChild>
                  <Link href={`/portal/${contactId}/search`}>
                    Browse Properties
                  </Link>
                </Button>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              {upcomingItems.map((item: any) => (
                <ShowingCard key={`${item.type}-${item.id}`} item={item} contactId={contactId} />
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="completed" className="space-y-4">
          {completedItems.length === 0 ? (
            <Card>
              <CardContent className="py-8 text-center">
                <p className="text-muted-foreground">No completed tours yet</p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              {completedItems.map((item: any) => (
                <ShowingCard key={`${item.type}-${item.id}`} item={item} contactId={contactId} showFeedback />
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="all" className="space-y-4">
          {allItems.length === 0 ? (
            <Card>
              <CardContent className="py-8 text-center">
                <p className="text-muted-foreground">No tours scheduled yet</p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              {allItems.map((item: any) => (
                <ShowingCard key={`${item.type}-${item.id}`} item={item} contactId={contactId} />
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>

      {/* Legacy ShowingsManager for any additional functionality */}
      <div className="hidden">
        <ShowingsManager contactId={contactId} />
      </div>
    </div>
  )
}

// Tour Card Component with expandable stops
function TourCard({ tour, contactId }: { tour: any; contactId: string }) {
  const status = STATUS_CONFIG[tour.status] || STATUS_CONFIG.planned
  const StatusIcon = status.icon
  const tourDate = new Date(tour.tour_date)
  const stops = tour.tour_stops ?? []
  const sortedStops = [...stops].sort((a: any, b: any) => (a.order_index ?? 0) - (b.order_index ?? 0))

  return (
    <Card>
      <Collapsible>
        <CardContent className="p-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <Route className="h-5 w-5 text-primary" />
                <h3 className="font-semibold">
                  {tourDate.toLocaleDateString("en-US", {
                    weekday: "long",
                    month: "short",
                    day: "numeric",
                  })}
                </h3>
                <Badge variant="secondary" className={cn("shrink-0", status.color)}>
                  <StatusIcon className="h-3 w-3 mr-1" />
                  {status.label}
                </Badge>
                {tour.all_confirmed && (
                  <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200">
                    <CheckCircle className="h-3 w-3 mr-1" />
                    All Confirmed
                  </Badge>
                )}
              </div>
              <p className="text-sm text-muted-foreground">
                {sortedStops.length} {sortedStops.length === 1 ? "property" : "properties"} on this tour
              </p>
            </div>
            <CollapsibleTrigger asChild>
              <Button variant="ghost" size="sm">
                View Stops
                <ChevronDown className="h-4 w-4 ml-1" />
              </Button>
            </CollapsibleTrigger>
          </div>

          <CollapsibleContent className="mt-4 space-y-3">
            {/* AI Tour Plan Narrative */}
            {tour.ai_plan_narrative && (
              <div className="p-3 rounded-lg bg-primary/5 border border-primary/10">
                <p className="text-sm font-medium flex items-center gap-1 mb-1">
                  <Sparkles className="h-4 w-4 text-primary" />
                  AI Tour Plan
                </p>
                <p className="text-sm text-muted-foreground">{tour.ai_plan_narrative}</p>
              </div>
            )}

            {/* Tour Stops */}
            <div className="space-y-2">
              {sortedStops.map((stop: any, index: number) => (
                <div
                  key={stop.id}
                  className="flex items-center gap-3 p-3 rounded-lg border bg-card"
                >
                  {/* Order number */}
                  <div className="h-8 w-8 rounded-full bg-primary/10 text-primary flex items-center justify-center text-sm font-semibold shrink-0">
                    {index + 1}
                  </div>

                  {/* Property Image */}
                  <div className="h-12 w-12 rounded-lg bg-muted flex items-center justify-center shrink-0 overflow-hidden">
                    {stop.primary_photo_url ? (
                      <img
                        src={stop.primary_photo_url}
                        alt={stop.property_address}
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <Home className="h-5 w-5 text-muted-foreground" />
                    )}
                  </div>

                  {/* Property Details */}
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm truncate">{stop.property_address}</p>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      {stop.list_price && <span>${stop.list_price.toLocaleString()}</span>}
                      {stop.suggested_time && (
                        <>
                          <span className="text-muted-foreground/50">|</span>
                          <span>{stop.suggested_time}</span>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Status badges */}
                  <div className="flex items-center gap-2 shrink-0">
                    {stop.is_confirmed && (
                      <Badge variant="outline" className="text-xs bg-green-50 text-green-700 border-green-200">
                        <CheckCircle className="h-3 w-3 mr-1" />
                        Confirmed
                      </Badge>
                    )}
                    {stop.buyer_interest_level && INTEREST_LEVEL_CONFIG[stop.buyer_interest_level] && (
                      <Badge
                        variant="secondary"
                        className={cn("text-xs", INTEREST_LEVEL_CONFIG[stop.buyer_interest_level].color)}
                      >
                        {INTEREST_LEVEL_CONFIG[stop.buyer_interest_level].label}
                      </Badge>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {/* Tour Notes */}
            {tour.notes && (
              <div className="p-2 bg-muted rounded-lg">
                <p className="text-sm text-muted-foreground">{tour.notes}</p>
              </div>
            )}
          </CollapsibleContent>
        </CardContent>
      </Collapsible>
    </Card>
  )
}

// Showing Card Component
function ShowingCard({
  item,
  contactId,
  showFeedback = false,
}: {
  item: any
  contactId: string
  showFeedback?: boolean
}) {
  const status = STATUS_CONFIG[item.status] || STATUS_CONFIG.pending
  const address = item.listing?.address || item.listing?.property_address || "Property"
  const StatusIcon = status.icon

  const showingDate = new Date(item.date)
  const isPast = showingDate < new Date()

  return (
    <Card className={cn(isPast && "opacity-75")}>
      <CardContent className="p-4">
        <div className="flex flex-col sm:flex-row gap-4">
          {/* Property Image/Icon */}
          <div className="h-20 w-20 rounded-lg bg-muted flex items-center justify-center shrink-0 overflow-hidden">
            {item.listing?.primary_photo_url ? (
              <img
                src={item.listing.primary_photo_url}
                alt={address}
                className="h-full w-full object-cover"
              />
            ) : (
              <Home className="h-8 w-8 text-muted-foreground" />
            )}
          </div>

          {/* Details */}
          <div className="flex-1 min-w-0 space-y-2">
            <div className="flex items-start justify-between gap-2">
              <div>
                <h3 className="font-semibold">{address}</h3>
                <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground mt-1">
                  {item.listing?.list_price && (
                    <span>${item.listing.list_price.toLocaleString()}</span>
                  )}
                  {item.listing?.bedrooms && (
                    <span>{item.listing.bedrooms}bd / {item.listing.bathrooms || 0}ba</span>
                  )}
                </div>
              </div>
              <Badge variant="secondary" className={cn("shrink-0", status.color)}>
                <StatusIcon className="h-3 w-3 mr-1" />
                {status.label}
              </Badge>
            </div>

            {/* Date/Time */}
            <div className="flex items-center gap-2 text-sm">
              <Calendar className="h-4 w-4 text-muted-foreground" />
              <span>
                {showingDate.toLocaleDateString("en-US", {
                  weekday: "short",
                  month: "short",
                  day: "numeric",
                })}
                {" at "}
                {showingDate.toLocaleTimeString("en-US", {
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </span>
            </div>

            {/* Interest Level (if rated) */}
            {item.buyer_interest_level && INTEREST_LEVEL_CONFIG[item.buyer_interest_level] && (
              <Badge
                variant="secondary"
                className={cn("text-xs", INTEREST_LEVEL_CONFIG[item.buyer_interest_level].color)}
              >
                {INTEREST_LEVEL_CONFIG[item.buyer_interest_level].label}
              </Badge>
            )}

            {/* Feedback (for completed) */}
            {showFeedback && item.feedback && (
              <div className="mt-2 p-2 bg-muted rounded-lg">
                <p className="text-sm font-medium flex items-center gap-1">
                  <Star className="h-4 w-4 text-amber-500" />
                  Your Feedback
                </p>
                <p className="text-sm text-muted-foreground mt-1">{item.feedback}</p>
              </div>
            )}

            {/* Actions */}
            {!isPast && !["cancelled", "denied"].includes(item.status) && (
              <div className="flex gap-2 pt-2">
                <Button variant="outline" size="sm" asChild>
                  <Link href={`/portal/${contactId}/properties/${item.listing_id}`}>
                    View Property
                  </Link>
                </Button>
                <Button variant="ghost" size="sm" asChild>
                  <Link href={`/portal/${contactId}/messages`}>
                    <MessageSquare className="h-4 w-4 mr-1" />
                    Message Agent
                  </Link>
                </Button>
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
