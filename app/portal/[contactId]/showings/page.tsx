import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import Link from "next/link"
import { determinePortalView } from "@/lib/kernel/portal"
import { ShowingsManager } from "@/components/portal/ShowingsManager"
import { Card, CardContent, CardHeader, CardTitle } from "@/app/components/ui/card"
import { Button } from "@/app/components/ui/button"
import { Badge } from "@/app/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/app/components/ui/tabs"
import { ArrowLeft, Calendar, Eye, Clock, CheckCircle, XCircle, MapPin, Home, MessageSquare, Star } from "lucide-react"
import { cn } from "@/lib/utils"

// Status config
const STATUS_CONFIG: Record<string, { label: string; color: string; icon: any }> = {
  pending: { label: "Pending", color: "bg-amber-100 text-amber-800", icon: Clock },
  confirmed: { label: "Confirmed", color: "bg-blue-100 text-blue-800", icon: CheckCircle },
  completed: { label: "Completed", color: "bg-green-100 text-green-800", icon: CheckCircle },
  cancelled: { label: "Cancelled", color: "bg-red-100 text-red-800", icon: XCircle },
  rescheduled: { label: "Rescheduled", color: "bg-purple-100 text-purple-800", icon: Calendar },
}

export default async function ShowingsPage({
  params,
}: {
  params: Promise<{ contactId: string }>
}) {
  const { contactId } = await params
  const supabase = await createClient()

  // Verify buyer portal view
  const portalView = await determinePortalView(supabase, contactId)
  if (portalView !== "buyer") {
    redirect(`/portal/${contactId}`)
  }

  const { data: contact, error: contactError } = await supabase
    .from("contacts")
    .select("id, first_name, last_name, name")
    .eq("id", contactId)
    .single()

  if (!contact || contactError) {
    redirect("/portal?error=contact_not_found")
  }

  // Fetch showings and showing_requests
  const [showingsResult, requestsResult] = await Promise.all([
    supabase
      .from("showings")
      .select("id, listing_id, showing_date, status, feedback, notes, listing:listings(id, address, property_address, list_price, bedrooms, bathrooms, primary_photo_url)")
      .eq("contact_id", contactId)
      .order("showing_date", { ascending: false }),
    supabase
      .from("showing_requests")
      .select("id, listing_id, requested_time, confirmed_date, status, notes, listing:listings(id, address, property_address, list_price, bedrooms, bathrooms, primary_photo_url)")
      .eq("contact_id", contactId)
      .order("requested_time", { ascending: false }),
  ])

  const showings = showingsResult.data ?? []
  const requests = requestsResult.data ?? []

  // Combine and categorize
  const now = new Date()
  const allItems = [
    ...showings.map((s: any) => ({
      ...s,
      type: "showing" as const,
      date: s.showing_date,
    })),
    ...requests.map((r: any) => ({
      ...r,
      type: "request" as const,
      date: r.confirmed_date || r.requested_time,
    })),
  ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())

  const upcomingItems = allItems.filter(
    (item) => new Date(item.date) >= now && !["cancelled", "completed"].includes(item.status)
  ).sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())

  const completedItems = allItems.filter(
    (item) => item.status === "completed" || (new Date(item.date) < now && item.status !== "cancelled")
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
          <h1 className="text-3xl font-bold">My Showings</h1>
          <p className="text-muted-foreground mt-1">Schedule property tours and provide feedback</p>
        </div>
        <Button asChild>
          <Link href={`/portal/${contactId}/messages`}>
            <Calendar className="h-4 w-4 mr-2" />
            Request Showing
          </Link>
        </Button>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="upcoming" className="space-y-4">
        <TabsList>
          <TabsTrigger value="upcoming">Upcoming ({upcomingItems.length})</TabsTrigger>
          <TabsTrigger value="completed">Completed ({completedItems.length})</TabsTrigger>
          <TabsTrigger value="all">All ({allItems.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="upcoming" className="space-y-4">
          {upcomingItems.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center">
                <Eye className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
                <h3 className="text-lg font-semibold mb-2">No upcoming showings</h3>
                <p className="text-muted-foreground mb-4">
                  Find a property you like and schedule a showing
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
                <p className="text-muted-foreground">No completed showings yet</p>
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
                <p className="text-muted-foreground">No showings scheduled yet</p>
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
            {!isPast && item.status !== "cancelled" && (
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
