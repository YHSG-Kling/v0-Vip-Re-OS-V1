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

  // Mock property data - in production this would come from IDX API or database
  const property = savedProperty?.property_data || {
    id: propertyId,
    mlsNumber: propertyId,
    address: "123 Main Street",
    city: "Austin",
    state: "TX",
    zip: "78701",
    price: 450000,
    beds: 3,
    baths: 2,
    sqft: 1850,
    yearBuilt: 2018,
    lotSize: "0.25 acres",
    garage: 2,
    propertyType: "Single Family",
    status: "Active",
    daysOnMarket: 12,
    description: "Beautiful modern home in the heart of Austin. Features include an open floor plan, updated kitchen with granite countertops and stainless steel appliances, hardwood floors throughout, and a spacious backyard perfect for entertaining. Close to downtown, restaurants, and parks.",
    features: [
      "Open Floor Plan",
      "Granite Countertops",
      "Stainless Steel Appliances",
      "Hardwood Floors",
      "Central A/C",
      "Attached Garage",
      "Fenced Backyard",
      "Updated Bathrooms",
    ],
    photos: [
      "/placeholder.svg?height=600&width=800&query=modern+home+exterior",
      "/placeholder.svg?height=600&width=800&query=modern+kitchen+interior",
      "/placeholder.svg?height=600&width=800&query=living+room+interior",
      "/placeholder.svg?height=600&width=800&query=master+bedroom+interior",
      "/placeholder.svg?height=600&width=800&query=backyard+patio",
    ],
    taxInfo: {
      annualTax: 8500,
      assessedValue: 420000,
    },
    hoa: {
      fee: 150,
      frequency: "monthly",
    },
    schools: [
      { name: "Austin Elementary", type: "Elementary", rating: 8, distance: "0.5 mi" },
      { name: "Central Middle School", type: "Middle", rating: 7, distance: "1.2 mi" },
      { name: "Austin High School", type: "High", rating: 9, distance: "2.1 mi" },
    ],
    agent: {
      name: "Sarah Johnson",
      phone: "(512) 555-1234",
      email: "sarah@realestate.com",
      photo: "/placeholder.svg?height=100&width=100&query=real+estate+agent+professional",
    },
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

  // Calculate monthly payment estimate
  const calculateMonthlyPayment = () => {
    const principal = property.price * 0.8 // 20% down
    const rate = 0.065 / 12 // 6.5% annual rate
    const n = 360 // 30 year mortgage
    const payment = (principal * rate * Math.pow(1 + rate, n)) / (Math.pow(1 + rate, n) - 1)
    const taxes = property.taxInfo?.annualTax ? property.taxInfo.annualTax / 12 : 0
    const hoa = property.hoa?.fee || 0
    return Math.round(payment + taxes + hoa)
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
            <Badge className="absolute top-4 left-4 bg-green-500">
              {property.status}
            </Badge>
            <Badge className="absolute top-4 right-4" variant="secondary">
              {property.daysOnMarket} days on market
            </Badge>
          </div>
          <div className="flex gap-2 mt-2 overflow-x-auto pb-2">
            {property.photos?.map((photo: string, idx: number) => (
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
        </div>

        {/* Quick Info Card */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-3xl font-bold text-green-600">
                ${property.price?.toLocaleString()}
              </CardTitle>
            </div>
            <CardDescription className="flex items-center gap-1 text-base">
              <MapPin className="w-4 h-4" />
              {property.address}, {property.city}, {property.state} {property.zip}
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

            <div className="p-4 bg-slate-50 rounded-lg">
              <p className="text-sm text-muted-foreground mb-1">Estimated Monthly Payment</p>
              <p className="text-2xl font-bold">${calculateMonthlyPayment().toLocaleString()}/mo</p>
              <p className="text-xs text-muted-foreground">Based on 20% down, 6.5% rate</p>
            </div>

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
          <TabsTrigger value="features">Features</TabsTrigger>
          <TabsTrigger value="financials">Financials</TabsTrigger>
          <TabsTrigger value="schools">Schools</TabsTrigger>
          <TabsTrigger value="location">Location</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>About This Home</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-muted-foreground leading-relaxed">{property.description}</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Property Details</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-slate-100 rounded-lg">
                    <Home className="w-5 h-5 text-muted-foreground" />
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Type</p>
                    <p className="font-medium">{property.propertyType}</p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-slate-100 rounded-lg">
                    <CalendarIcon className="w-5 h-5 text-muted-foreground" />
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Year Built</p>
                    <p className="font-medium">{property.yearBuilt}</p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-slate-100 rounded-lg">
                    <Ruler className="w-5 h-5 text-muted-foreground" />
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Lot Size</p>
                    <p className="font-medium">{property.lotSize}</p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-slate-100 rounded-lg">
                    <Car className="w-5 h-5 text-muted-foreground" />
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Garage</p>
                    <p className="font-medium">{property.garage} Car</p>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="features" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Home Features</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                {property.features?.map((feature: string, idx: number) => (
                  <div key={idx} className="flex items-center gap-2 p-3 bg-slate-50 rounded-lg">
                    <CheckCircle className="w-4 h-4 text-green-500" />
                    <span className="text-sm">{feature}</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="financials" className="space-y-6">
          <div className="grid md:grid-cols-2 gap-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Calculator className="w-5 h-5" />
                  Monthly Cost Breakdown
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex justify-between py-2 border-b">
                  <span>Principal & Interest</span>
                  <span className="font-medium">
                    ${Math.round(calculateMonthlyPayment() - (property.taxInfo?.annualTax || 0) / 12 - (property.hoa?.fee || 0)).toLocaleString()}
                  </span>
                </div>
                <div className="flex justify-between py-2 border-b">
                  <span>Property Tax</span>
                  <span className="font-medium">
                    ${Math.round((property.taxInfo?.annualTax || 0) / 12).toLocaleString()}
                  </span>
                </div>
                {property.hoa?.fee && (
                  <div className="flex justify-between py-2 border-b">
                    <span>HOA Fee</span>
                    <span className="font-medium">${property.hoa.fee}</span>
                  </div>
                )}
                <div className="flex justify-between py-2 font-bold text-lg">
                  <span>Total Monthly</span>
                  <span className="text-green-600">${calculateMonthlyPayment().toLocaleString()}</span>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <DollarSign className="w-5 h-5" />
                  Tax Information
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex justify-between py-2 border-b">
                  <span>Annual Tax</span>
                  <span className="font-medium">${property.taxInfo?.annualTax?.toLocaleString()}</span>
                </div>
                <div className="flex justify-between py-2 border-b">
                  <span>Tax Assessed Value</span>
                  <span className="font-medium">${property.taxInfo?.assessedValue?.toLocaleString()}</span>
                </div>
                <div className="flex justify-between py-2">
                  <span>Tax Rate</span>
                  <span className="font-medium">
                    {((property.taxInfo?.annualTax / property.taxInfo?.assessedValue) * 100).toFixed(2)}%
                  </span>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="schools" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <School className="w-5 h-5" />
                Nearby Schools
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {property.schools?.map((school: any, idx: number) => (
                  <div key={idx} className="flex items-center justify-between p-4 bg-slate-50 rounded-lg">
                    <div className="flex items-center gap-4">
                      <div className="p-3 bg-white rounded-full">
                        <School className="w-5 h-5 text-primary" />
                      </div>
                      <div>
                        <p className="font-medium">{school.name}</p>
                        <p className="text-sm text-muted-foreground">{school.type} • {school.distance}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Star className="w-4 h-4 text-yellow-500 fill-yellow-500" />
                      <span className="font-bold">{school.rating}/10</span>
                    </div>
                  </div>
                ))}
              </div>
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
