"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Heart, MapPin, Bed, Bath, Square, Calendar, Sparkles, Users, Plus, Loader2 } from "lucide-react"
import { SmartPropertyInsights } from "./SmartPropertyInsights"
import { addPropertyToSearch, getCollaborativeSearches } from "@/app/actions/collaborative-search"
import { requestShowing } from "@/app/actions/smart-insights"
import { getSavedProperties } from "@/app/actions/properties"

interface PortalPropertiesViewProps {
  contactId: string
  contactEmail: string
}

export function PortalPropertiesView({ contactId, contactEmail }: PortalPropertiesViewProps) {
  const [savedProperties, setSavedProperties] = useState<any[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [selectedProperty, setSelectedProperty] = useState<any>(null)
  const [showInsights, setShowInsights] = useState(false)
  const [collaborativeSearches, setCollaborativeSearches] = useState<any[]>([])
  const [showingDates, setShowingDates] = useState<{ date: string; time: string }[]>([{ date: "", time: "" }])
  const [showingNotes, setShowingNotes] = useState("")
  const [showShowingDialog, setShowShowingDialog] = useState(false)
  const [showAddToSearchDialog, setShowAddToSearchDialog] = useState(false)

  useEffect(() => {
    loadData()
  }, [contactId])

  async function loadData() {
    setIsLoading(true)
    try {
      const [properties, searches] = await Promise.all([
        getSavedProperties(contactId),
        getCollaborativeSearches(contactId)
      ])
      setSavedProperties(properties.success ? properties.properties : [])
      setCollaborativeSearches(searches || [])
    } catch (error) {
      console.error("[PortalPropertiesView] Error loading data:", error)
    } finally {
      setIsLoading(false)
    }
  }

  async function loadCollaborativeSearches() {
    const searches = await getCollaborativeSearches(contactId)
    setCollaborativeSearches(searches)
  }

  async function handleAddToSearch(searchId: string) {
    if (!selectedProperty) return
    await addPropertyToSearch(searchId, selectedProperty.id, selectedProperty, contactEmail)
    setShowAddToSearchDialog(false)
  }

  async function handleRequestShowing() {
    if (!selectedProperty || showingDates.every((d) => !d.date)) return

    const validDates = showingDates.filter((d) => d.date)
    await requestShowing(
      contactId,
      selectedProperty.id,
      `${selectedProperty.address}, ${selectedProperty.city}, ${selectedProperty.state}`,
      selectedProperty,
      validDates,
      showingNotes,
    )

    setShowShowingDialog(false)
    setShowingDates([{ date: "", time: "" }])
    setShowingNotes("")
  }

  return (
    <div className="space-y-6">
      <Tabs defaultValue="saved" className="space-y-4">
        <TabsList>
          <TabsTrigger value="saved" className="flex items-center gap-2">
            <Heart className="h-4 w-4" />
            Saved Properties
          </TabsTrigger>
          <TabsTrigger value="recommended" className="flex items-center gap-2">
            <Sparkles className="h-4 w-4" />
            Recommended
          </TabsTrigger>
        </TabsList>

        <TabsContent value="saved" className="space-y-4">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : savedProperties.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <Heart className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p>No saved properties yet.</p>
              <p className="text-sm">Properties you save will appear here.</p>
            </div>
          ) : (
            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
              {savedProperties.map((property) => (
                <Card key={property.id} className="overflow-hidden hover:shadow-lg transition-shadow">
                  <div className="aspect-video relative bg-muted">
                    <img
                      src={property.image || "/placeholder.svg"}
                      alt={property.address}
                      className="object-cover w-full h-full"
                    />
                    <Button size="icon" variant="secondary" className="absolute top-2 right-2 bg-white/90">
                      <Heart className="h-4 w-4 text-red-500 fill-red-500" />
                    </Button>
                  </div>
                  <CardHeader className="pb-2">
                    <div className="flex items-start justify-between">
                      <div>
                        <CardTitle className="text-lg">${property.price.toLocaleString()}</CardTitle>
                        <CardDescription className="flex items-center gap-1">
                          <MapPin className="h-3 w-3" />
                          {property.address}, {property.city}
                        </CardDescription>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="flex items-center gap-4 text-sm text-muted-foreground mb-4">
                      <span className="flex items-center gap-1">
                        <Bed className="h-4 w-4" />
                        {property.bedrooms}
                      </span>
                      <span className="flex items-center gap-1">
                        <Bath className="h-4 w-4" />
                        {property.bathrooms}
                      </span>
                      <span className="flex items-center gap-1">
                        <Square className="h-4 w-4" />
                        {property.sqft.toLocaleString()} sqft
                      </span>
                    </div>

                    <div className="flex flex-wrap gap-1 mb-4">
                      {property.features.slice(0, 3).map((feature: any) => (
                        <Badge key={feature} variant="secondary" className="text-xs">
                          {feature}
                        </Badge>
                      ))}
                    </div>

                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        className="flex-1 bg-transparent"
                        onClick={() => {
                          setSelectedProperty(property)
                          setShowInsights(true)
                        }}
                      >
                        <Sparkles className="h-4 w-4 mr-1" />
                        Insights
                      </Button>
                      <Button
                        size="sm"
                        className="flex-1"
                        onClick={() => {
                          setSelectedProperty(property)
                          setShowShowingDialog(true)
                        }}
                      >
                        <Calendar className="h-4 w-4 mr-1" />
                        Schedule
                      </Button>
                    </div>

                    {collaborativeSearches.length > 0 && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="w-full mt-2"
                        onClick={() => {
                          setSelectedProperty(property)
                          setShowAddToSearchDialog(true)
                        }}
                      >
                        <Users className="h-4 w-4 mr-1" />
                        Add to Family Search
                      </Button>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="recommended">
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12">
              <Sparkles className="h-12 w-12 text-muted-foreground mb-4" />
              <h3 className="font-semibold text-lg">AI-Powered Recommendations Coming</h3>
              <p className="text-muted-foreground text-sm text-center mt-1">
                Based on your search behavior and preferences
              </p>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Smart Insights Dialog */}
      <Dialog open={showInsights} onOpenChange={setShowInsights}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Property Insights</DialogTitle>
            <DialogDescription>
              {selectedProperty?.address}, {selectedProperty?.city}, {selectedProperty?.state}
            </DialogDescription>
          </DialogHeader>
          {selectedProperty && (
            <SmartPropertyInsights
              propertyId={selectedProperty.id}
              propertyData={selectedProperty}
              contactId={contactId}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Request Showing Dialog */}
      <Dialog open={showShowingDialog} onOpenChange={setShowShowingDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Schedule a Showing</DialogTitle>
            <DialogDescription>
              {selectedProperty?.address}, {selectedProperty?.city}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>Preferred Date & Time</Label>
              {showingDates.map((dt, idx) => (
                <div key={idx} className="flex gap-2">
                  <Input
                    type="date"
                    value={dt.date}
                    onChange={(e) => {
                      const newDates = [...showingDates]
                      newDates[idx].date = e.target.value
                      setShowingDates(newDates)
                    }}
                    className="flex-1"
                  />
                  <Input
                    type="time"
                    value={dt.time}
                    onChange={(e) => {
                      const newDates = [...showingDates]
                      newDates[idx].time = e.target.value
                      setShowingDates(newDates)
                    }}
                    className="w-32"
                  />
                </div>
              ))}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowingDates([...showingDates, { date: "", time: "" }])}
              >
                <Plus className="h-4 w-4 mr-1" />
                Add another time
              </Button>
            </div>

            <div className="space-y-2">
              <Label>Notes (optional)</Label>
              <Textarea
                placeholder="Any special requests or questions?"
                value={showingNotes}
                onChange={(e) => setShowingNotes(e.target.value)}
              />
            </div>

            <Button onClick={handleRequestShowing} className="w-full">
              Request Showing
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Add to Family Search Dialog */}
      <Dialog open={showAddToSearchDialog} onOpenChange={setShowAddToSearchDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add to Family Search</DialogTitle>
            <DialogDescription>Select which search to add this property to</DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-4">
            {collaborativeSearches.map((search) => (
              <Button
                key={search.id}
                variant="outline"
                className="w-full justify-start bg-transparent"
                onClick={() => handleAddToSearch(search.id)}
              >
                <Users className="h-4 w-4 mr-2" />
                {search.name}
                <span className="text-muted-foreground ml-auto">
                  {search.collaborative_search_members?.length || 0} members
                </span>
              </Button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
