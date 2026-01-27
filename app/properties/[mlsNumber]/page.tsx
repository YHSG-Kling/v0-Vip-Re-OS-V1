"use client"

import { useState, useEffect } from "react"
import { useParams, useSearchParams } from "next/navigation"
import { trackPropertyView, saveProperty } from "@/app/actions/idx-search"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Heart, MapPin, Bed, Bath, Maximize, Calendar, Share2 } from "lucide-react"
import { useToast } from "@/hooks/use-toast"

export default function PropertyDetailPage() {
  const params = useParams()
  const searchParams = useSearchParams()
  const { toast } = useToast()
  const mlsNumber = params.mlsNumber as string
  const contactId = searchParams.get("contactId") || "demo-contact-id"

  const [timeSpent, setTimeSpent] = useState(0)
  const [property, setProperty] = useState<any>(null)

  useEffect(() => {
    // Mock property data - would fetch from IDX API
    setProperty({
      mlsNumber: mlsNumber,
      address: "123 Oak Street",
      city: "Austin",
      state: "TX",
      zip: "78701",
      price: 450000,
      beds: 3,
      baths: 2.5,
      sqft: 2100,
      propertyType: "single_family",
      daysOnMarket: 12,
      status: "Active",
      photos: ["/modern-house-exterior.png"],
      description: "Beautiful 3-bedroom home in a prime location with modern updates throughout.",
      yearBuilt: 2015,
      lotSize: 0.25,
      parking: "2-car garage",
      features: ["Pool", "Fireplace", "Hardwood Floors", "Updated Kitchen"],
    })

    // Track time spent
    const interval = setInterval(() => {
      setTimeSpent((prev) => prev + 1)
    }, 1000)

    return () => {
      clearInterval(interval)
      if (timeSpent > 10) {
        trackPropertyView({ contactId, mlsNumber, timeSpent })
      }
    }
  }, [mlsNumber, contactId])

  const handleSave = async () => {
    const result = await saveProperty({
      contactId,
      mlsNumber,
      propertyData: property,
    })

    if (result.success) {
      toast({
        title: "Saved",
        description: "Property added to your favorites",
      })
    }
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

  return (
    <div className="min-h-screen bg-background p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        {/* Photo Gallery */}
        <div className="aspect-video mb-8 rounded-lg overflow-hidden">
          <img
            src={property.photos[0] || "/placeholder.svg"}
            alt={property.address}
            className="w-full h-full object-cover"
          />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Main Content */}
          <div className="lg:col-span-2 space-y-6">
            <div className="flex items-start justify-between">
              <div>
                <h1 className="text-4xl font-bold text-primary mb-2">${property.price.toLocaleString()}</h1>
                <p className="text-lg text-muted-foreground flex items-center gap-2">
                  <MapPin className="h-5 w-5" />
                  {property.address}, {property.city}, {property.state} {property.zip}
                </p>
              </div>
              <div className="flex gap-2">
                <Button size="icon" variant="outline" onClick={handleSave}>
                  <Heart className="h-5 w-5" />
                </Button>
                <Button size="icon" variant="outline">
                  <Share2 className="h-5 w-5" />
                </Button>
              </div>
            </div>

            <div className="flex gap-6">
              <div className="flex items-center gap-2">
                <Bed className="h-5 w-5 text-muted-foreground" />
                <span className="font-semibold">{property.beds}</span>
                <span className="text-muted-foreground">beds</span>
              </div>
              <div className="flex items-center gap-2">
                <Bath className="h-5 w-5 text-muted-foreground" />
                <span className="font-semibold">{property.baths}</span>
                <span className="text-muted-foreground">baths</span>
              </div>
              <div className="flex items-center gap-2">
                <Maximize className="h-5 w-5 text-muted-foreground" />
                <span className="font-semibold">{property.sqft.toLocaleString()}</span>
                <span className="text-muted-foreground">sqft</span>
              </div>
            </div>

            <Tabs defaultValue="description">
              <TabsList>
                <TabsTrigger value="description">Description</TabsTrigger>
                <TabsTrigger value="features">Features</TabsTrigger>
                <TabsTrigger value="location">Location</TabsTrigger>
              </TabsList>
              <TabsContent value="description" className="space-y-4">
                <Card>
                  <CardContent className="pt-6">
                    <p className="text-lg leading-relaxed">{property.description}</p>
                  </CardContent>
                </Card>
              </TabsContent>
              <TabsContent value="features" className="space-y-4">
                <Card>
                  <CardContent className="pt-6">
                    <div className="grid grid-cols-2 gap-4">
                      {property.features.map((feature: string) => (
                        <Badge key={feature} variant="secondary" className="justify-start">
                          {feature}
                        </Badge>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              </TabsContent>
              <TabsContent value="location" className="space-y-4">
                <Card>
                  <CardContent className="pt-6">
                    <div className="aspect-video bg-muted rounded-lg flex items-center justify-center">
                      <MapPin className="h-12 w-12 text-muted-foreground" />
                    </div>
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
                  <span className="text-muted-foreground">Status</span>
                  <Badge>{property.status}</Badge>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Days on Market</span>
                  <span className="font-semibold">{property.daysOnMarket}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Year Built</span>
                  <span className="font-semibold">{property.yearBuilt}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Lot Size</span>
                  <span className="font-semibold">{property.lotSize} acres</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Parking</span>
                  <span className="font-semibold">{property.parking}</span>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="pt-6 space-y-3">
                <Button className="w-full" size="lg">
                  <Calendar className="mr-2 h-5 w-5" />
                  Schedule Showing
                </Button>
                <Button variant="outline" className="w-full bg-transparent" size="lg">
                  Contact Agent
                </Button>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  )
}
