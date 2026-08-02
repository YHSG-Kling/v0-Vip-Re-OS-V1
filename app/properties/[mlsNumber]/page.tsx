"use client"

/**
 * Public property page, keyed by MLS NUMBER.
 *
 * Two things were wrong here and they compounded each other:
 *
 *  1. The property was INVENTED. `useEffect` set a hard-coded "123 Oak Street,
 *     Austin TX, $450,000" object regardless of the MLS number in the URL, so
 *     every listing anyone shared from PortalSocialHub — which hands out this
 *     exact `/properties/<mls>` URL — rendered the same fabricated home.
 *  2. Three controls (Share / Schedule Showing / Contact Agent) had no handler,
 *     so even the fabricated home did nothing.
 *
 * Facts now come from getPublicPropertyByMlsNumber, which reads OUR listings
 * rows and only those in a publicly-marketed status. An MLS number that does
 * not resolve is reported as not found rather than dressed up as a listing.
 *
 * Two id spaces, kept apart: this route's param is an OUTSIDE identifier (an MLS
 * number). `property.listingId` is our own listings.id and is the only value
 * ever passed to an action that expects a listing UUID.
 */

import { useState, useEffect, useRef } from "react"
import { useParams, useSearchParams } from "next/navigation"
import {
  trackPropertyView,
  saveProperty,
  getPublicPropertyByMlsNumber,
  type PublicPropertyFacts,
} from "@/app/actions/idx-search"
import { requestShowing } from "@/app/actions/showings"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Heart, MapPin, Bed, Bath, Maximize, Calendar, Share2, Mail } from "lucide-react"
import { useToast } from "@/hooks/use-toast"

export default function PropertyDetailPage() {
  const params = useParams()
  const searchParams = useSearchParams()
  const { toast } = useToast()
  const mlsNumber = params.mlsNumber as string

  // NO PLACEHOLDER. The old "demo-contact-id" fallback is not a uuid, so every
  // action it was handed failed a uuid parse and the failure looked like a bug
  // in the save rather than a missing client. Absent means absent.
  const contactId = searchParams.get("contactId")

  const [property, setProperty] = useState<PublicPropertyFacts | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // Showing request
  const [showingOpen, setShowingOpen] = useState(false)
  const [showingDate, setShowingDate] = useState("")
  const [showingTime, setShowingTime] = useState("")
  const [showingNotes, setShowingNotes] = useState("")
  const [requesting, setRequesting] = useState(false)

  // Read by the unmount handler. State would be captured stale in the cleanup
  // closure, which is why the old version could only ever report 0 seconds.
  const timeSpentRef = useRef(0)

  useEffect(() => {
    let cancelled = false
    setProperty(null)
    setLoadError(null)

    getPublicPropertyByMlsNumber(mlsNumber).then((res) => {
      if (cancelled) return
      if (res.success) setProperty(res.property)
      else setLoadError(res.error)
    })

    return () => {
      cancelled = true
    }
  }, [mlsNumber])

  useEffect(() => {
    timeSpentRef.current = 0
    const interval = setInterval(() => {
      timeSpentRef.current += 1
    }, 1000)

    return () => {
      clearInterval(interval)
      // Engagement scoring is per-contact; with no contact there is nothing to
      // attribute the view to.
      if (contactId && timeSpentRef.current > 10) {
        void trackPropertyView({ contactId, mlsNumber, timeSpent: timeSpentRef.current })
      }
    }
  }, [mlsNumber, contactId])

  const handleSave = async () => {
    if (!property) return
    if (!contactId) {
      toast({
        title: "No client selected",
        description:
          "A saved property belongs to a specific client. Open this listing from a client's record.",
        variant: "destructive",
      })
      return
    }

    setSaving(true)
    try {
      const result = await saveProperty({
        contactId,
        // Our own listing: pass the UUID, and let the MLS number ride along as
        // the outside identifier. Never the MLS number in the listingId slot.
        listingId: property.listingId,
        mlsNumber: property.mlsNumber ?? undefined,
        source: "brokerage_listing",
        propertyData: {
          address:          property.address ?? undefined,
          price:            property.price ?? undefined,
          bedrooms:         property.beds ?? undefined,
          bathrooms:        property.baths ?? undefined,
          sqft:             property.sqft ?? undefined,
          propertyType:     property.propertyType ?? undefined,
          primaryPhotoUrl:  property.photos[0],
          city:             property.city ?? undefined,
          state:            property.state ?? undefined,
        },
      })

      // saveProperty resolves with { success:false, error } on an RLS refusal
      // or a failed insert — it does not throw.
      if (result.success) {
        toast({
          title: result.alreadySaved ? "Already saved" : "Saved",
          description: result.message ?? "Property added to this client's favorites.",
        })
      } else {
        toast({
          title: "Not saved",
          description: result.error ?? "The save was refused.",
          variant: "destructive",
        })
      }
    } finally {
      setSaving(false)
    }
  }

  const handleShare = async () => {
    if (typeof window === "undefined") return
    const url = window.location.origin + `/properties/${mlsNumber}`
    const title = property
      ? [property.address, property.city, property.state].filter(Boolean).join(", ")
      : `MLS #${mlsNumber}`

    if (navigator.share) {
      try {
        await navigator.share({ title: title || "Property", url })
        return
      } catch (e: any) {
        // A cancelled share sheet is not a failure worth reporting.
        if (e?.name === "AbortError") return
      }
    }
    try {
      await navigator.clipboard.writeText(url)
      toast({ title: "Link copied", description: url })
    } catch {
      toast({ title: "Could not copy the link", description: url, variant: "destructive" })
    }
  }

  const handleRequestShowing = async () => {
    if (!property) return
    if (!contactId) return
    if (!showingDate || !showingTime) {
      toast({
        title: "Pick a date and time",
        description: "The request carries a preferred date and time to the listing side.",
        variant: "destructive",
      })
      return
    }

    setRequesting(true)
    try {
      const result = await requestShowing({
        contactId,
        listingId:       property.listingId,
        propertyAddress: [property.address, property.city, property.state]
          .filter(Boolean)
          .join(", "),
        propertyCity:    property.city ?? undefined,
        propertyState:   property.state ?? undefined,
        propertyZip:     property.zip ?? undefined,
        mlsNumber:       property.mlsNumber ?? undefined,
        listPrice:       property.price ?? undefined,
        primaryPhotoUrl: property.photos[0],
        source:          "agent_input",
        preferredDates:  [{ date: showingDate, time: showingTime }],
        clientNotes:     showingNotes || undefined,
      })

      // A BBA-gate refusal comes back as { success:false, error } — it is not
      // thrown, so it has to be read or the button is a silent no-op.
      if (result.success) {
        toast({ title: "Showing requested", description: "Your agent will confirm the time." })
        setShowingOpen(false)
      } else {
        toast({
          title: "Showing not requested",
          description: result.error ?? "The request was refused.",
          variant: "destructive",
        })
      }
    } finally {
      setRequesting(false)
    }
  }

  if (loadError) {
    return (
      <div className="min-h-screen bg-background p-8">
        <div className="max-w-2xl mx-auto text-center py-16 space-y-2">
          <h1 className="text-2xl font-semibold">Listing not available</h1>
          <p className="text-muted-foreground">{loadError}</p>
        </div>
      </div>
    )
  }

  if (!property) {
    return (
      <div className="min-h-screen bg-background p-8">
        <div className="max-w-7xl mx-auto text-center py-12">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto" />
        </div>
      </div>
    )
  }

  const mailtoHref = property.listingAgentEmail
    ? `mailto:${property.listingAgentEmail}` +
      `?subject=${encodeURIComponent(`Inquiry — MLS #${property.mlsNumber ?? mlsNumber}`)}` +
      `&body=${encodeURIComponent(
        `I'd like more information about ${[property.address, property.city, property.state]
          .filter(Boolean)
          .join(", ")}.`,
      )}`
    : null

  return (
    <div className="min-h-screen bg-background p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        {/* Photo Gallery */}
        <div className="aspect-video mb-8 rounded-lg overflow-hidden bg-muted">
          {property.photos[0] ? (
            <img
              src={property.photos[0]}
              alt={property.address ?? "Property"}
              className="w-full h-full object-cover"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-muted-foreground">
              No photos on this listing yet
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Main Content */}
          <div className="lg:col-span-2 space-y-6">
            <div className="flex items-start justify-between">
              <div>
                <h1 className="text-4xl font-bold text-primary mb-2">
                  {property.price != null
                    ? `$${property.price.toLocaleString()}`
                    : "Price on request"}
                </h1>
                <p className="text-lg text-muted-foreground flex items-center gap-2">
                  <MapPin className="h-5 w-5" />
                  {[property.address, property.city, property.state, property.zip]
                    .filter(Boolean)
                    .join(", ")}
                </p>
              </div>
              <div className="flex gap-2">
                <Button size="icon" variant="outline" onClick={handleSave} disabled={saving}>
                  <Heart className="h-5 w-5" />
                </Button>
                {/* Had no handler. The canonical share link for a listing is
                    this page — PortalSocialHub already publishes exactly this
                    URL to Facebook / X / LinkedIn. */}
                <Button
                  size="icon"
                  variant="outline"
                  onClick={handleShare}
                  title="Share this listing"
                >
                  <Share2 className="h-5 w-5" />
                </Button>
              </div>
            </div>

            <div className="flex gap-6 flex-wrap">
              {property.beds != null && (
                <div className="flex items-center gap-2">
                  <Bed className="h-5 w-5 text-muted-foreground" />
                  <span className="font-semibold">{property.beds}</span>
                  <span className="text-muted-foreground">beds</span>
                </div>
              )}
              {property.baths != null && (
                <div className="flex items-center gap-2">
                  <Bath className="h-5 w-5 text-muted-foreground" />
                  <span className="font-semibold">{property.baths}</span>
                  <span className="text-muted-foreground">baths</span>
                </div>
              )}
              {property.sqft != null && (
                <div className="flex items-center gap-2">
                  <Maximize className="h-5 w-5 text-muted-foreground" />
                  <span className="font-semibold">{property.sqft.toLocaleString()}</span>
                  <span className="text-muted-foreground">sqft</span>
                </div>
              )}
            </div>

            <Tabs defaultValue="description">
              <TabsList>
                <TabsTrigger value="description">Description</TabsTrigger>
                <TabsTrigger value="location">Location</TabsTrigger>
              </TabsList>
              <TabsContent value="description" className="space-y-4">
                <Card>
                  <CardContent className="pt-6">
                    {/* public_remarks is the only listing prose we hold. When a
                        listing has none, say so — do not fill the gap. */}
                    <p className="text-lg leading-relaxed">
                      {property.description ?? (
                        <span className="text-muted-foreground text-base">
                          This listing has no public description yet.
                        </span>
                      )}
                    </p>
                  </CardContent>
                </Card>
              </TabsContent>
              <TabsContent value="location" className="space-y-4">
                <Card>
                  <CardContent className="pt-6">
                    <p className="text-muted-foreground flex items-center gap-2">
                      <MapPin className="h-5 w-5" />
                      {[property.address, property.city, property.state, property.zip]
                        .filter(Boolean)
                        .join(", ")}
                    </p>
                  </CardContent>
                </Card>
              </TabsContent>
            </Tabs>
          </div>

          {/* Sidebar */}
          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Property Details</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">MLS #</span>
                  <span className="font-semibold">{property.mlsNumber ?? mlsNumber}</span>
                </div>
                {property.status && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Status</span>
                    <Badge className="capitalize">{property.status.replace("_", " ")}</Badge>
                  </div>
                )}
                {property.daysOnMarket != null && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Days on Market</span>
                    <span className="font-semibold">{property.daysOnMarket}</span>
                  </div>
                )}
                {property.yearBuilt != null && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Year Built</span>
                    <span className="font-semibold">{property.yearBuilt}</span>
                  </div>
                )}
                {property.lotSize != null && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Lot Size</span>
                    <span className="font-semibold">{property.lotSize} acres</span>
                  </div>
                )}
                {property.propertyType && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Type</span>
                    <span className="font-semibold capitalize">
                      {property.propertyType.replace("_", " ")}
                    </span>
                  </div>
                )}
                {property.listingAgentName && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Listed by</span>
                    <span className="font-semibold">{property.listingAgentName}</span>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardContent className="pt-6 space-y-3">
                {/* Only rendered with a client in context: requestShowing writes
                    a showing_requests row FOR a contact, and there is no
                    anonymous showing-request path in this product. */}
                {contactId ? (
                  <Button className="w-full" size="lg" onClick={() => setShowingOpen(true)}>
                    <Calendar className="mr-2 h-5 w-5" />
                    Schedule Showing
                  </Button>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Showings are requested through your agent.
                  </p>
                )}

                {/* "Contact Agent" reaches the listing agent recorded on this
                    listing. With no email on the row there is no one to reach,
                    so the control is not rendered rather than shown dead. */}
                {mailtoHref && (
                  <Button variant="outline" className="w-full bg-transparent" size="lg" asChild>
                    <a href={mailtoHref}>
                      <Mail className="mr-2 h-5 w-5" />
                      Contact Agent
                    </a>
                  </Button>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>

      <Dialog open={showingOpen} onOpenChange={setShowingOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Request a showing</DialogTitle>
            <DialogDescription>
              {[property.address, property.city, property.state].filter(Boolean).join(", ")}
              {property.mlsNumber ? ` · MLS #${property.mlsNumber}` : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="detail-showing-date">Preferred date</Label>
                <Input
                  id="detail-showing-date"
                  type="date"
                  min={new Date().toISOString().slice(0, 10)}
                  value={showingDate}
                  onChange={(e) => setShowingDate(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="detail-showing-time">Preferred time</Label>
                <Input
                  id="detail-showing-time"
                  type="time"
                  value={showingTime}
                  onChange={(e) => setShowingTime(e.target.value)}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="detail-showing-notes">Notes (optional)</Label>
              <Textarea
                id="detail-showing-notes"
                placeholder="Alternate times, who is attending…"
                value={showingNotes}
                onChange={(e) => setShowingNotes(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              onClick={handleRequestShowing}
              disabled={requesting || !showingDate || !showingTime}
            >
              {requesting ? "Sending…" : "Request showing"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
