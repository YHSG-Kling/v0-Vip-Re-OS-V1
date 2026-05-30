"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Calendar } from "@/components/ui/calendar"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { toast } from "@/hooks/use-toast"
import {
  ArrowLeft,
  Heart,
  Share2,
  Calendar as CalendarIcon,
  MapPin,
  Bed,
  Bath,
  Square,
  Car,
  Home,
  DollarSign,
  TrendingUp,
  Calculator,
  School,
  TreePine,
  Phone,
  Mail,
  Clock,
  CheckCircle,
  Star,
  MessageSquare,
  Building,
  Ruler,
  Thermometer,
  Droplets,
  Zap,
} from "lucide-react"
import { requestShowing, saveProperty } from "@/app/actions/smart-insights"

interface PropertyDetailsViewProps {
  contactId: string
  propertyId: string
  contact: any
  savedProperty: any
  showings: any[]
}

export function PropertyDetailsView({
  contactId,
  propertyId,
  contact,
  savedProperty,
  showings,
}: PropertyDetailsViewProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [isSaved, setIsSaved] = useState(!!savedProperty)
  const [showScheduleDialog, setShowScheduleDialog] = useState(false)
  const [selectedDate, setSelectedDate] = useState<Date | undefined>(undefined)
  const [showingNotes, setShowingNotes] = useState("")
  const [activeImageIndex, setActiveImageIndex] = useState(0)

  // Real property facts come from the saved_properties row (flat columns).
  // Fields the schema does not carry (description, features, schools, tax, HOA,
  // year built, lot size, garage, multi-photo gallery) are intentionally left
  // empty and their UI sections degrade gracefully rather than show placeholders.
  const property = {
    id: savedProperty?.id ?? propertyId,
    mlsNumber: savedProperty?.mls_number ?? null,
    address: savedProperty?.property_address ?? "",
    city: savedProperty?.city ?? "",
    state: savedProperty?.state ?? "",
    zip: "",
    price: savedProperty?.list_price ?? null,
    beds: savedProperty?.bedrooms ?? null,
    baths: savedProperty?.bathrooms ?? null,
    sqft: savedProperty?.sqft ?? null,
    propertyType: savedProperty?.property_type ?? null,
    listingUrl: savedProperty?.listing_url ?? null,
    matchScore: savedProperty?.ai_match_score ?? null,
    matchReasons: (savedProperty?.match_reasons as string[] | null) ?? [],
    photos: savedProperty?.primary_photo_url ? [savedProperty.primary_photo_url] : [],
    yearBuilt: null as number | null,
    lotSize: null as string | null,
    garage: null as number | null,
    description: null as string | null,
    features: [] as string[],
    schools: [] as { name: string; type: string; rating: number; distance: string }[],
    taxInfo: null as { annualTax: number; assessedValue: number } | null,
    hoa: null as { fee: number; frequency: string } | null,
    agent: null as { name: string; phone?: string; email?: string; photo?: string } | null,
  }

  const handleSaveProperty = () => {
    startTransition(async () => {
      const result = await saveProperty({
        contactId,
        propertyId,
        propertyAddress: `${property.address}, ${property.city}, ${property.state}`,
        propertyData: property,
      })
      if (result.success) {
        setIsSaved(true)
        toast({
          title: "Property Saved",
          description: "Added to your favorites",
        })
      }
    })
  }

  const handleScheduleShowing = () => {
    if (!selectedDate) {
      toast({
        title: "Select a Date",
        description: "Please choose a date for your showing",
        variant: "destructive",
      })
      return
    }

    startTransition(async () => {
      const result = await requestShowing(
        contactId,
        propertyId,
        `${property.address}, ${property.city}, ${property.state}`,
        property,
        [{ date: selectedDate.toISOString(), time: "" }],
        showingNotes,
      )
      if (!result.error) {
        toast({
          title: "Showing Requested",
          description: "We'll confirm your appointment soon!",
        })
        setShowScheduleDialog(false)
        setSelectedDate(undefined)
        setShowingNotes("")
      }
    })
  }

  // Principal & interest estimate from the real list price (20% down, 6.5%, 30y).
  // Returns null when we have no price so the UI hides the estimate rather than
  // showing a fabricated number.
  const calculateMonthlyPayment = (): number | null => {
    if (!property.price || property.price <= 0) return null
    const principal = property.price * 0.8
    const rate = 0.065 / 12
    const n = 360
    const payment = (principal * rate * Math.pow(1 + rate, n)) / (Math.pow(1 + rate, n) - 1)
    return Math.round(payment)
  }

  return (
    <div className="space-y-6">
      {/* Back Button & Actions */}
      <div className="flex items-center justify-between">
        <Button variant="ghost" onClick={() => router.back()} className="bg-transparent">
          <ArrowLeft className="w-4 h-4 mr-2" />
          Back to Properties
        </Button>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="icon"
            onClick={handleSaveProperty}
            disabled={isPending}
            className={`bg-transparent ${isSaved ? "text-red-500" : ""}`}
          >
            <Heart className={`w-5 h-5 ${isSaved ? "fill-red-500" : ""}`} />
          </Button>
          <Button variant="outline" size="icon" className="bg-transparent">
            <Share2 className="w-5 h-5" />
          </Button>
        </div>
      </div>

      {/* Photo Gallery */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2">
          <div className="relative aspect-video rounded-lg overflow-hidden bg-slate-100">
            <img
              src={property.photos?.[activeImageIndex] || "/placeholder.svg?height=600&width=800&query=home+exterior"}
              alt={property.address}
              className="w-full h-full object-cover"
            />
            {property.matchScore != null && (
              <Badge className="absolute top-4 left-4 bg-green-500">
                {property.matchScore}% match
              </Badge>
            )}
          </div>
          {property.photos.length > 1 && (
            <div className="flex gap-2 mt-2 overflow-x-auto pb-2">
              {property.photos.map((photo: string, idx: number) => (
                <button
                  key={idx}
                  onClick={() => setActiveImageIndex(idx)}
                  className={`flex-shrink-0 w-20 h-20 rounded-lg overflow-hidden border-2 transition-all ${
                    activeImageIndex === idx ? "border-primary" : "border-transparent"
                  }`}
                >
                  <img src={photo || "/placeholder.svg"} alt={`View ${idx + 1}`} className="w-full h-full object-cover" />
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Quick Info Card */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-3xl font-bold text-green-600">
                {property.price != null ? `$${property.price.toLocaleString()}` : "Price on request"}
              </CardTitle>
            </div>
            <CardDescription className="flex items-center gap-1 text-base">
              <MapPin className="w-4 h-4" />
              {[property.address, property.city, property.state].filter(Boolean).join(", ")}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-3 gap-4 text-center">
              <div>
                <p className="text-2xl font-bold">{property.beds}</p>
                <p className="text-sm text-muted-foreground flex items-center justify-center gap-1">
                  <Bed className="w-4 h-4" /> Beds
                </p>
              </div>
              <div>
                <p className="text-2xl font-bold">{property.baths}</p>
                <p className="text-sm text-muted-foreground flex items-center justify-center gap-1">
                  <Bath className="w-4 h-4" /> Baths
                </p>
              </div>
              <div>
                <p className="text-2xl font-bold">{property.sqft?.toLocaleString()}</p>
                <p className="text-sm text-muted-foreground flex items-center justify-center gap-1">
                  <Square className="w-4 h-4" /> Sqft
                </p>
              </div>
            </div>

            {calculateMonthlyPayment() != null && (
              <div className="p-4 bg-slate-50 rounded-lg">
                <p className="text-sm text-muted-foreground mb-1">Estimated Monthly Payment</p>
                <p className="text-2xl font-bold">${calculateMonthlyPayment()!.toLocaleString()}/mo</p>
                <p className="text-xs text-muted-foreground">Principal &amp; interest only — 20% down, 6.5%, 30yr</p>
              </div>
            )}

            <Dialog open={showScheduleDialog} onOpenChange={setShowScheduleDialog}>
              <DialogTrigger asChild>
                <Button className="w-full" size="lg">
                  <CalendarIcon className="w-5 h-5 mr-2" />
                  Schedule a Tour
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Schedule a Showing</DialogTitle>
                  <DialogDescription>
                    Pick your preferred date and we'll confirm the appointment.
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-4">
                  <Calendar
                    mode="single"
                    selected={selectedDate}
                    onSelect={setSelectedDate}
                    disabled={(date) => date < new Date()}
                    className="rounded-md border mx-auto"
                  />
                  <div className="space-y-2">
                    <Label>Notes (optional)</Label>
                    <Textarea
                      placeholder="Any specific times or requests..."
                      value={showingNotes}
                      onChange={(e) => setShowingNotes(e.target.value)}
                    />
                  </div>
                  <Button
                    className="w-full"
                    onClick={handleScheduleShowing}
                    disabled={isPending || !selectedDate}
                  >
                    {isPending ? "Submitting..." : "Request Showing"}
                  </Button>
                </div>
              </DialogContent>
            </Dialog>

            <Button variant="outline" className="w-full bg-transparent" asChild>
              <Link href={`/portal/${contactId}/messages?property=${propertyId}`}>
                <MessageSquare className="w-5 h-5 mr-2" />
                Ask a Question
              </Link>
            </Button>
          </CardContent>
        </Card>
      </div>

      {/* Property Details Tabs */}
      <Tabs defaultValue="overview" className="w-full">
        <TabsList className="w-full justify-start">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="financials">Financials</TabsTrigger>
          <TabsTrigger value="location">Location</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-6">
          {property.description && (
            <Card>
              <CardHeader>
                <CardTitle>About This Home</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-muted-foreground leading-relaxed">{property.description}</p>
              </CardContent>
            </Card>
          )}

          {property.matchReasons.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Why this matches you</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {property.matchReasons.map((reason, idx) => (
                    <div key={idx} className="flex items-center gap-2">
                      <CheckCircle className="w-4 h-4 text-green-500 flex-shrink-0" />
                      <span className="text-sm">{reason}</span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Property Details</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {property.propertyType && (
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-slate-100 rounded-lg">
                      <Home className="w-5 h-5 text-muted-foreground" />
                    </div>
                    <div>
                      <p className="text-sm text-muted-foreground">Type</p>
                      <p className="font-medium capitalize">{property.propertyType}</p>
                    </div>
                  </div>
                )}
                {property.mlsNumber && (
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-slate-100 rounded-lg">
                      <Building className="w-5 h-5 text-muted-foreground" />
                    </div>
                    <div>
                      <p className="text-sm text-muted-foreground">MLS #</p>
                      <p className="font-medium">{property.mlsNumber}</p>
                    </div>
                  </div>
                )}
                {property.sqft != null && (
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-slate-100 rounded-lg">
                      <Square className="w-5 h-5 text-muted-foreground" />
                    </div>
                    <div>
                      <p className="text-sm text-muted-foreground">Living Area</p>
                      <p className="font-medium">{property.sqft.toLocaleString()} sqft</p>
                    </div>
                  </div>
                )}
              </div>
              {property.listingUrl && (
                <a
                  href={property.listingUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-4 inline-flex items-center gap-1 text-sm text-primary underline"
                >
                  View full listing
                </a>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="financials" className="space-y-6">
          <Card className="max-w-md">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Calculator className="w-5 h-5" />
                Estimated Monthly Payment
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {calculateMonthlyPayment() != null ? (
                <>
                  <div className="flex justify-between py-2 font-bold text-lg">
                    <span>Principal &amp; Interest</span>
                    <span className="text-green-600">${calculateMonthlyPayment()!.toLocaleString()}/mo</span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Estimate only — assumes 20% down, 6.5% rate, 30-year fixed. Taxes,
                    insurance, and HOA are not included. Talk to your agent or lender
                    for a precise quote.
                  </p>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No list price on file for this property yet.
                </p>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="location" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <MapPin className="w-5 h-5" />
                Location
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="aspect-video bg-slate-100 rounded-lg flex items-center justify-center">
                <div className="text-center text-muted-foreground">
                  <MapPin className="w-12 h-12 mx-auto mb-2" />
                  <p>Interactive map would display here</p>
                  <p className="text-sm">{property.address}, {property.city}, {property.state} {property.zip}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Listing Agent Card */}
      {property.agent && (
        <Card>
          <CardHeader>
            <CardTitle>Listing Agent</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-4">
              <img
                src={property.agent.photo || "/placeholder.svg"}
                alt={property.agent.name}
                className="w-16 h-16 rounded-full object-cover"
              />
              <div className="flex-1">
                <p className="font-semibold text-lg">{property.agent.name}</p>
                <div className="flex items-center gap-4 text-sm text-muted-foreground mt-1">
                  <span className="flex items-center gap-1">
                    <Phone className="w-4 h-4" />
                    {property.agent.phone}
                  </span>
                  <span className="flex items-center gap-1">
                    <Mail className="w-4 h-4" />
                    {property.agent.email}
                  </span>
                </div>
              </div>
              <Button variant="outline" className="bg-transparent">
                <Phone className="w-4 h-4 mr-2" />
                Contact Agent
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Existing Showings */}
      {showings && showings.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Clock className="w-5 h-5" />
              Your Scheduled Showings
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {showings.map((showing: any) => (
                <div key={showing.id} className="flex items-center justify-between p-4 bg-slate-50 rounded-lg">
                  <div>
                    <p className="font-medium">
                      {showing.confirmed_date
                        ? new Date(showing.confirmed_date).toLocaleDateString("en-US", {
                            weekday: "long",
                            month: "long",
                            day: "numeric",
                            hour: "numeric",
                            minute: "2-digit",
                          })
                        : "Pending confirmation"}
                    </p>
                    {showing.notes && (
                      <p className="text-sm text-muted-foreground">{showing.notes}</p>
                    )}
                  </div>
                  <Badge variant={showing.status === "confirmed" ? "default" : "secondary"}>
                    {showing.status}
                  </Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
