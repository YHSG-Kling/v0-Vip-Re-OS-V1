"use client"

import { useState, useEffect } from "react"
import { useSearchParams } from "next/navigation"
import { getSavedProperties, unsaveProperty } from "@/app/actions/idx-search"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Heart, MapPin, Bed, Bath, Maximize, Trash2 } from "lucide-react"
import { useToast } from "@/hooks/use-toast"
import Link from "next/link"

export default function SavedPropertiesContent() {
  const searchParams = useSearchParams()
  const { toast } = useToast()
  const [properties, setProperties] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  const contactId = searchParams.get("contactId") || "demo-contact-id"

  useEffect(() => {
    loadSavedProperties()
  }, [contactId])

  const loadSavedProperties = async () => {
    const result = await getSavedProperties(contactId)
    if (result.success) {
      setProperties(result.properties)
    }
    setLoading(false)
  }

  const handleUnsave = async (mlsNumber: string) => {
    const result = await unsaveProperty({ contactId, mlsNumber })

    if (result.success) {
      setProperties(properties.filter((p) => p.mls_number !== mlsNumber))
      toast({
        title: "Removed",
        description: result.message,
      })
    }
  }

  if (loading) {
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
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold">Saved Properties</h1>
            <p className="text-muted-foreground mt-1">{properties.length} properties saved</p>
          </div>
          <Button asChild variant="outline">
            <Link href={`/properties/search?contactId=${contactId}`}>Search More</Link>
          </Button>
        </div>

        {properties.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center">
              <Heart className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
              <h3 className="text-lg font-semibold mb-2">No saved properties yet</h3>
              <p className="text-muted-foreground mb-4">Start searching to save your favorite properties</p>
              <Button asChild>
                <Link href={`/properties/search?contactId=${contactId}`}>Search Properties</Link>
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
            {properties.map((property) => (
              <Card key={property.id} className="overflow-hidden hover:shadow-lg transition-shadow">
                <div className="relative aspect-video">
                  <img
                    src={property.listing_photos?.[0] || "/placeholder.svg?height=300&width=400&query=house"}
                    alt={property.property_address}
                    className="w-full h-full object-cover"
                  />
                  <Button
                    variant="destructive"
                    size="icon"
                    className="absolute top-2 right-2"
                    onClick={() => handleUnsave(property.mls_number)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
                <CardContent className="p-4">
                  <h3 className="text-2xl font-bold text-primary mb-2">${property.list_price?.toLocaleString()}</h3>
                  <p className="text-sm text-muted-foreground mb-3 flex items-center gap-1">
                    <MapPin className="h-3 w-3" />
                    {property.property_address}
                  </p>
                  <div className="flex gap-4 text-sm mb-4">
                    <span className="flex items-center gap-1">
                      <Bed className="h-4 w-4" />
                      {property.beds} beds
                    </span>
                    <span className="flex items-center gap-1">
                      <Bath className="h-4 w-4" />
                      {property.baths} baths
                    </span>
                    <span className="flex items-center gap-1">
                      <Maximize className="h-4 w-4" />
                      {property.sqft?.toLocaleString()} sqft
                    </span>
                  </div>
                  {property.notes && <p className="text-sm text-muted-foreground mb-4 italic">"{property.notes}"</p>}
                  <Button asChild className="w-full">
                    <Link href={`/properties/${property.mls_number}?contactId=${contactId}`}>View Details</Link>
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
