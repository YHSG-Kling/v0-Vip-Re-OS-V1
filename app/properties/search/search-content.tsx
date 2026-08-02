"use client"

import { useState } from "react"
import { useSearchParams } from "next/navigation"
import { searchProperties, smartSearch, saveProperty } from "@/app/actions/idx-search"
import { requestShowing } from "@/app/actions/showings"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Slider } from "@/components/ui/slider"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Checkbox } from "@/components/ui/checkbox"
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
import { Search, Heart, Grid3x3, List, MapPin, Bed, Bath, Maximize } from "lucide-react"
import { useToast } from "@/hooks/use-toast"
import Link from "next/link"

export default function PropertySearchContent() {
  const searchParams = useSearchParams()
  const { toast } = useToast()

  const [naturalQuery, setNaturalQuery] = useState("")
  const [properties, setProperties] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid")
  const [showFilters, setShowFilters] = useState(true)
  const [filters, setFilters] = useState({
    minPrice: 0,
    maxPrice: 1000000,
    beds: undefined as number | undefined,
    baths: undefined as number | undefined,
    propertyType: [] as string[],
    city: "",
    mlsStatus: ["Active"] as string[],
  })
  const [extractedFilters, setExtractedFilters] = useState<any>(null)

  // "Schedule" on every result card had no handler. requestShowing has handled
  // OUTSIDE properties (listingId undefined + mls/address/price fields) since
  // it was written — these IDX results are exactly that case.
  const [showingProperty, setShowingProperty] = useState<any | null>(null)
  const [showingDate, setShowingDate] = useState("")
  const [showingTime, setShowingTime] = useState("")
  const [showingNotes, setShowingNotes] = useState("")
  const [requestingShowing, setRequestingShowing] = useState(false)

  // No fallback. "demo-contact-id" is not a uuid, so every action given it
  // failed a uuid parse — including the ALREADY-WIRED heart button, which showed
  // a destructive "Error" toast on a page that otherwise looked healthy. A
  // placeholder id does not make a feature work without a contact; it makes the
  // failure look like a bug in the save.
  const contactId = searchParams.get("contactId")

  const handleSmartSearch = async () => {
    if (!naturalQuery.trim()) return
    // smartSearch personalises against the contact's budget, persona, timeline
    // and search history, and throws outright when the contact row is missing —
    // which is what the old "demo-contact-id" fallback guaranteed.
    if (!contactId) {
      toast({
        title: "No client selected",
        description: "Smart search reads the client's budget and history. Open it from a client's record.",
        variant: "destructive",
      })
      return
    }

    setLoading(true)
    try {
      const result = await smartSearch({
        naturalLanguageQuery: naturalQuery,
        contactId: contactId,
      })

      if (result.success) {
        setProperties(result.properties)
        setExtractedFilters(result.filters)
        toast({
          title: "Search Complete",
          description: result.interpretation,
        })
      } else {
        toast({
          title: "Search Failed",
          description: result.error,
          variant: "destructive",
        })
      }
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to search properties",
        variant: "destructive",
      })
    } finally {
      setLoading(false)
    }
  }

  const handleFilterSearch = async () => {
    setLoading(true)
    try {
      const result = await searchProperties(filters)

      if (result.success) {
        setProperties(result.properties)
        setExtractedFilters(null)
      }
    } finally {
      setLoading(false)
    }
  }

  const handleSaveProperty = async (property: any) => {
    if (!contactId) {
      toast({
        title: "No client selected",
        description: "Open this search from a client's record to save properties for them.",
        variant: "destructive",
      })
      return
    }
    const result = await saveProperty({
      contactId: contactId,
      mlsNumber: property.mlsNumber,
      propertyData: property,
    })

    if (result.success) {
      toast({
        title: result.alreadySaved ? "Already Saved" : "Property Saved",
        description: result.message,
      })
    } else {
      toast({
        title: "Error",
        description: result.error,
        variant: "destructive",
      })
    }
  }

  const handleOpenSchedule = (property: any) => {
    if (!contactId) {
      toast({
        title: "No client selected",
        description: "A showing is requested for a specific client. Open this search from a client's record.",
        variant: "destructive",
      })
      return
    }
    setShowingProperty(property)
    setShowingDate("")
    setShowingTime("")
    setShowingNotes("")
  }

  const handleRequestShowing = async () => {
    if (!contactId || !showingProperty) return
    if (!showingDate || !showingTime) {
      toast({
        title: "Pick a date and time",
        description: "The request carries a preferred date and time to the listing side.",
        variant: "destructive",
      })
      return
    }

    setRequestingShowing(true)
    try {
      // No listingId: an IDX result is an OUTSIDE property keyed by its MLS
      // number, never one of our listings.id values.
      const result = await requestShowing({
        contactId,
        mlsNumber:       showingProperty.mlsNumber,
        propertyAddress: showingProperty.address,
        propertyCity:    showingProperty.city,
        propertyState:   showingProperty.state,
        propertyZip:     showingProperty.zip,
        listPrice:       showingProperty.price,
        primaryPhotoUrl: showingProperty.photos?.[0],
        source:          "agent_input",
        preferredDates:  [{ date: showingDate, time: showingTime }],
        clientNotes:     showingNotes || undefined,
      })

      // requestShowing resolves with { success:false, error } on a BBA-gate
      // refusal or an insert failure — it does not throw, so an unread result
      // would be a silent no-op.
      if (result.success) {
        toast({
          title: "Showing requested",
          description: `Request sent for ${showingProperty.address}.`,
        })
        setShowingProperty(null)
      } else {
        toast({
          title: "Showing not requested",
          description: result.error ?? "The request was refused.",
          variant: "destructive",
        })
      }
    } finally {
      setRequestingShowing(false)
    }
  }

  return (
    <div className="min-h-screen bg-background p-4 md:p-8">
      <div className="max-w-7xl mx-auto mb-8">
        <Card className="border-2 border-primary/20">
          <CardContent className="pt-6">
            <div className="flex flex-col space-y-4">
              <div className="flex gap-2">
                <Input
                  type="text"
                  placeholder="Describe your dream home... (e.g., '3 bedroom near good schools under $400k')"
                  value={naturalQuery}
                  onChange={(e) => setNaturalQuery(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleSmartSearch()}
                  className="text-lg h-12"
                />
                <Button onClick={handleSmartSearch} disabled={loading} size="lg" className="min-w-[120px]">
                  <Search className="mr-2 h-5 w-5" />
                  {loading ? "Searching..." : "Search"}
                </Button>
              </div>

              <div className="flex flex-wrap gap-2 text-sm text-muted-foreground">
                <span>Examples:</span>
                <Badge
                  variant="outline"
                  className="cursor-pointer"
                  onClick={() => setNaturalQuery("3 bedroom near good schools under $400k")}
                >
                  3 bedroom near schools under $400k
                </Badge>
                <Badge
                  variant="outline"
                  className="cursor-pointer"
                  onClick={() => setNaturalQuery("Modern condo downtown with parking")}
                >
                  Modern condo downtown with parking
                </Badge>
                <Badge
                  variant="outline"
                  className="cursor-pointer"
                  onClick={() => setNaturalQuery("Investment property with rental income")}
                >
                  Investment property
                </Badge>
              </div>

              {extractedFilters && (
                <div className="pt-4 border-t">
                  <p className="text-sm font-medium mb-2">AI Interpreted Filters:</p>
                  <div className="flex flex-wrap gap-2">
                    {extractedFilters.minPrice && (
                      <Badge variant="secondary">Min: ${extractedFilters.minPrice.toLocaleString()}</Badge>
                    )}
                    {extractedFilters.maxPrice && (
                      <Badge variant="secondary">Max: ${extractedFilters.maxPrice.toLocaleString()}</Badge>
                    )}
                    {extractedFilters.beds && <Badge variant="secondary">{extractedFilters.beds}+ beds</Badge>}
                    {extractedFilters.baths && <Badge variant="secondary">{extractedFilters.baths}+ baths</Badge>}
                    {extractedFilters.city && <Badge variant="secondary">{extractedFilters.city}</Badge>}
                    {extractedFilters.propertyType?.map((type: string) => (
                      <Badge key={type} variant="secondary">
                        {type.replace("_", " ")}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="max-w-7xl mx-auto">
        <div className="flex flex-col lg:flex-row gap-6">
          <aside className={`lg:w-80 ${showFilters ? "block" : "hidden lg:block"}`}>
            <Card>
              <CardContent className="p-6 space-y-6">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="font-semibold">Filters</h3>
                  <Button variant="ghost" size="sm" onClick={handleFilterSearch}>
                    Apply
                  </Button>
                </div>

                <div>
                  <Label>Price Range</Label>
                  <Slider
                    value={[filters.minPrice, filters.maxPrice]}
                    onValueChange={([min, max]) => setFilters({ ...filters, minPrice: min, maxPrice: max })}
                    max={2000000}
                    step={10000}
                    className="mt-2"
                  />
                  <div className="flex justify-between mt-2 text-sm text-muted-foreground">
                    <span>${(filters.minPrice / 1000).toFixed(0)}k</span>
                    <span>${(filters.maxPrice / 1000).toFixed(0)}k</span>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label>Min Beds</Label>
                    <Select
                      value={filters.beds?.toString()}
                      onValueChange={(v) => setFilters({ ...filters, beds: Number.parseInt(v) })}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Any" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="1">1+</SelectItem>
                        <SelectItem value="2">2+</SelectItem>
                        <SelectItem value="3">3+</SelectItem>
                        <SelectItem value="4">4+</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label>Min Baths</Label>
                    <Select
                      value={filters.baths?.toString()}
                      onValueChange={(v) => setFilters({ ...filters, baths: Number.parseInt(v) })}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Any" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="1">1+</SelectItem>
                        <SelectItem value="2">2+</SelectItem>
                        <SelectItem value="3">3+</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div>
                  <Label>Property Type</Label>
                  <div className="space-y-2 mt-2">
                    {["single_family", "condo", "townhouse", "multi_family"].map((type) => (
                      <div key={type} className="flex items-center space-x-2">
                        <Checkbox
                          id={type}
                          checked={filters.propertyType.includes(type)}
                          onCheckedChange={(checked) => {
                            setFilters({
                              ...filters,
                              propertyType: checked
                                ? [...filters.propertyType, type]
                                : filters.propertyType.filter((t) => t !== type),
                            })
                          }}
                        />
                        <Label htmlFor={type} className="font-normal capitalize">
                          {type.replace("_", " ")}
                        </Label>
                      </div>
                    ))}
                  </div>
                </div>

                <div>
                  <Label>City</Label>
                  <Input
                    placeholder="Enter city"
                    value={filters.city}
                    onChange={(e) => setFilters({ ...filters, city: e.target.value })}
                  />
                </div>
              </CardContent>
            </Card>
          </aside>

          <main className="flex-1">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-2xl font-bold">{properties.length} Properties</h2>
              <div className="flex gap-2">
                <Button
                  variant={viewMode === "grid" ? "default" : "outline"}
                  size="icon"
                  onClick={() => setViewMode("grid")}
                >
                  <Grid3x3 className="h-4 w-4" />
                </Button>
                <Button
                  variant={viewMode === "list" ? "default" : "outline"}
                  size="icon"
                  onClick={() => setViewMode("list")}
                >
                  <List className="h-4 w-4" />
                </Button>
              </div>
            </div>

            {loading ? (
              <div className="text-center py-12">
                <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto" />
                <p className="mt-4 text-muted-foreground">Searching properties...</p>
              </div>
            ) : properties.length === 0 ? (
              <Card>
                <CardContent className="py-12 text-center">
                  <Search className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
                  <h3 className="text-lg font-semibold mb-2">No properties found</h3>
                  <p className="text-muted-foreground">
                    Try adjusting your search criteria or use the smart search above
                  </p>
                </CardContent>
              </Card>
            ) : (
              <div
                className={viewMode === "grid" ? "grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6" : "space-y-4"}
              >
                {properties.map((property) => (
                  <Card key={property.mlsNumber} className="overflow-hidden hover:shadow-lg transition-shadow">
                    <div className="relative aspect-video">
                      <img
                        src={property.photos?.[0] || "/placeholder.svg?height=300&width=400&query=house"}
                        alt={property.address}
                        className="w-full h-full object-cover"
                      />
                      <Button
                        variant="secondary"
                        size="icon"
                        className="absolute top-2 right-2"
                        onClick={() => handleSaveProperty(property)}
                      >
                        <Heart className="h-4 w-4" />
                      </Button>
                      <Badge className="absolute bottom-2 left-2">{property.status}</Badge>
                    </div>
                    <CardContent className="p-4">
                      <div className="flex justify-between items-start mb-2">
                        <h3 className="text-2xl font-bold text-primary">${property.price?.toLocaleString()}</h3>
                        <Badge variant="outline">{property.daysOnMarket} days</Badge>
                      </div>
                      <p className="text-sm text-muted-foreground mb-3 flex items-center gap-1">
                        <MapPin className="h-3 w-3" />
                        {property.address}, {property.city}
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
                      <div className="flex gap-2">
                        <Button asChild className="flex-1">
                          <Link href={`/properties/${property.mlsNumber}?contactId=${contactId}`}>View Details</Link>
                        </Button>
                        <Button variant="outline" onClick={() => handleOpenSchedule(property)}>
                          Schedule
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </main>
        </div>
      </div>

      <Dialog open={!!showingProperty} onOpenChange={(o) => !o && setShowingProperty(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Request a showing</DialogTitle>
            <DialogDescription>
              {showingProperty
                ? `${showingProperty.address}${showingProperty.city ? `, ${showingProperty.city}` : ""}${
                    showingProperty.mlsNumber ? ` · MLS #${showingProperty.mlsNumber}` : ""
                  }`
                : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="showing-date">Preferred date</Label>
                <Input
                  id="showing-date"
                  type="date"
                  value={showingDate}
                  min={new Date().toISOString().slice(0, 10)}
                  onChange={(e) => setShowingDate(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="showing-time">Preferred time</Label>
                <Input
                  id="showing-time"
                  type="time"
                  value={showingTime}
                  onChange={(e) => setShowingTime(e.target.value)}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="showing-notes">Notes for the listing side (optional)</Label>
              <Textarea
                id="showing-notes"
                placeholder="Access notes, alternate times, who is attending…"
                value={showingNotes}
                onChange={(e) => setShowingNotes(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              onClick={handleRequestShowing}
              disabled={requestingShowing || !showingDate || !showingTime}
            >
              {requestingShowing ? "Sending…" : "Request showing"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
