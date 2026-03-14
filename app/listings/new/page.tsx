"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { useAuth } from "@/lib/auth/client"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Loader2, Home, MapPin, DollarSign, User, ArrowLeft, Sparkles } from "lucide-react"
import Link from "next/link"
import { aiEnrichPropertyData, createListing } from "@/app/actions/ai-listing-intake"

const PROPERTY_TYPES = [
  { value: "single_family", label: "Single Family Home" },
  { value: "condo", label: "Condo/Apartment" },
  { value: "townhouse", label: "Townhouse" },
  { value: "multi_family", label: "Multi-Family" },
  { value: "land", label: "Land/Lot" },
  { value: "commercial", label: "Commercial" },
]

const US_STATES = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA",
  "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
  "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
  "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC",
  "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY"
]

export default function NewListingPage() {
  const router = useRouter()
  const { user, userContext, isLoading: authLoading } = useAuth()
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isEnriching, setIsEnriching] = useState(false)
  const [enrichedData, setEnrichedData] = useState<any>(null)
  
  const [formData, setFormData] = useState({
    address: "",
    city: "",
    state: "",
    zipCode: "",
    propertyType: "single_family",
    listPrice: "",
    sellerId: "",
  })

  // Redirect if not authenticated
  useEffect(() => {
    if (!authLoading && !user) {
      router.push("/login")
    }
  }, [authLoading, user, router])

  const handleEnrichProperty = async () => {
    if (!formData.address || !userContext?.agentId) return
    
    setIsEnriching(true)
    try {
      const fullAddress = `${formData.address}, ${formData.city}, ${formData.state} ${formData.zipCode}`
      const result = await aiEnrichPropertyData(fullAddress, userContext.agentId)
      if (result.success && result.data) {
        setEnrichedData(result.data)
      }
    } catch (error) {
      console.error("Error enriching property:", error)
    } finally {
      setIsEnriching(false)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!userContext?.agentId) return

    setIsSubmitting(true)
    try {
      const result = await createListing({
        agentId: userContext.agentId,
        propertyAddress: formData.address,
        city: formData.city,
        state: formData.state,
        zipCode: formData.zipCode,
        propertyType: formData.propertyType as any,
        sellerId: formData.sellerId || userContext.agentId, // Fallback to agent if no seller
        listPrice: formData.listPrice ? parseInt(formData.listPrice) : undefined,
        propertyDetails: enrichedData,
      })

      if (result.success && result.listing) {
        router.push(`/listings/${result.listing.id}`)
      }
    } catch (error) {
      console.error("Error creating listing:", error)
    } finally {
      setIsSubmitting(false)
    }
  }

  if (authLoading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="border-b border-border bg-card">
        <div className="max-w-4xl mx-auto px-6 py-4">
          <div className="flex items-center gap-4">
            <Link href="/dashboard/listings">
              <Button variant="ghost" size="sm">
                <ArrowLeft className="h-4 w-4 mr-2" />
                Back to Listings
              </Button>
            </Link>
            <div className="h-8 w-px bg-border" />
            <div>
              <h1 className="text-2xl font-bold text-foreground">New Listing</h1>
              <p className="text-sm text-muted-foreground">Create a new property listing</p>
            </div>
          </div>
        </div>
      </div>

      {/* Form */}
      <div className="max-w-4xl mx-auto px-6 py-8">
        <form onSubmit={handleSubmit} className="space-y-8">
          {/* Property Address */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <MapPin className="h-5 w-5" />
                Property Address
              </CardTitle>
              <CardDescription>Enter the property location details</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="address">Street Address</Label>
                <Input
                  id="address"
                  placeholder="123 Main Street"
                  value={formData.address}
                  onChange={(e) => setFormData({ ...formData, address: e.target.value })}
                  required
                />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="city">City</Label>
                  <Input
                    id="city"
                    placeholder="Austin"
                    value={formData.city}
                    onChange={(e) => setFormData({ ...formData, city: e.target.value })}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="state">State</Label>
                  <Select
                    value={formData.state}
                    onValueChange={(value) => setFormData({ ...formData, state: value })}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select state" />
                    </SelectTrigger>
                    <SelectContent>
                      {US_STATES.map((state) => (
                        <SelectItem key={state} value={state}>
                          {state}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="zipCode">ZIP Code</Label>
                  <Input
                    id="zipCode"
                    placeholder="78701"
                    value={formData.zipCode}
                    onChange={(e) => setFormData({ ...formData, zipCode: e.target.value })}
                    required
                  />
                </div>
              </div>
              
              {/* AI Enrich Button */}
              {formData.address && formData.city && formData.state && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleEnrichProperty}
                  disabled={isEnriching}
                  className="mt-4"
                >
                  {isEnriching ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Enriching...
                    </>
                  ) : (
                    <>
                      <Sparkles className="h-4 w-4 mr-2" />
                      AI Enrich Property Data
                    </>
                  )}
                </Button>
              )}

              {/* Enriched Data Preview */}
              {enrichedData && (
                <div className="mt-4 p-4 bg-muted rounded-lg">
                  <p className="text-sm font-medium mb-2">AI-Enriched Property Data:</p>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
                    <div>Beds: {enrichedData.beds}</div>
                    <div>Baths: {enrichedData.baths}</div>
                    <div>Sqft: {enrichedData.sqft?.toLocaleString()}</div>
                    <div>Year: {enrichedData.yearBuilt}</div>
                    <div>Est. Value: ${enrichedData.estimatedValue?.toLocaleString()}</div>
                    <div>Walk Score: {enrichedData.walkScore}</div>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Property Details */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Home className="h-5 w-5" />
                Property Details
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="propertyType">Property Type</Label>
                  <Select
                    value={formData.propertyType}
                    onValueChange={(value) => setFormData({ ...formData, propertyType: value })}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select type" />
                    </SelectTrigger>
                    <SelectContent>
                      {PROPERTY_TYPES.map((type) => (
                        <SelectItem key={type.value} value={type.value}>
                          {type.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="listPrice">List Price</Label>
                  <div className="relative">
                    <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                      id="listPrice"
                      type="number"
                      placeholder="450000"
                      className="pl-9"
                      value={formData.listPrice}
                      onChange={(e) => setFormData({ ...formData, listPrice: e.target.value })}
                    />
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Actions */}
          <div className="flex items-center justify-end gap-4">
            <Link href="/dashboard/listings">
              <Button variant="outline" type="button">Cancel</Button>
            </Link>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Creating...
                </>
              ) : (
                "Create Listing"
              )}
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}
