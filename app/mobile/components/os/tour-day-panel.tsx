"use client"

import { useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { MapPin, Clock, Navigation, Play, CheckCircle, Star, Phone, Car } from "lucide-react"
import { format } from "date-fns"
import { toast } from "sonner"

interface TourStop {
  id: string
  tour_id: string
  listing_id?: string
  property_address: string
  city?: string
  state?: string
  list_price?: number
  order_index: number
  suggested_time?: string
  confirmed_time?: string
  is_confirmed?: boolean
  buyer_interest_level?: string
  access_method?: string
  access_code?: string
  access_instructions?: string
  listing_agent_name?: string
  listing_agent_phone?: string
  drive_time_from_prev_minutes?: number
}

interface Tour {
  id: string
  contact_id: string
  tour_date: string
  status: string
  notes?: string
  contacts?: {
    first_name?: string
    last_name?: string
    phone?: string
  }
  tour_stops?: TourStop[]
}

interface TourDayPanelProps {
  tours: Tour[]
  onTourStart?: (tourId: string) => void
}

export function TourDayPanel({ tours, onTourStart }: TourDayPanelProps) {
  const [isPending, startTransition] = useTransition()
  const [expandedTourId, setExpandedTourId] = useState<string | null>(null)

  const today = new Date().toISOString().split("T")[0]
  const todaysTours = tours.filter((t) => t.tour_date === today && t.status !== "cancelled")

  const handleStartTour = (tourId: string) => {
    onTourStart?.(tourId)
    toast.success("Tour started - navigate to first stop")
  }

  const handleGetDirections = (address: string, city?: string, state?: string) => {
    const fullAddress = [address, city, state].filter(Boolean).join(", ")
    const encodedAddress = encodeURIComponent(fullAddress)
    window.open(`https://maps.google.com/maps?daddr=${encodedAddress}`, "_blank")
  }

  const handleCallAgent = (phone: string) => {
    window.location.href = `tel:${phone}`
  }

  const getInterestBadge = (level?: string) => {
    switch (level) {
      case "love_it":
        return <Badge className="bg-green-100 text-green-700 text-xs">Love It</Badge>
      case "like_it":
        return <Badge className="bg-blue-100 text-blue-700 text-xs">Like It</Badge>
      case "maybe":
        return <Badge className="bg-yellow-100 text-yellow-700 text-xs">Maybe</Badge>
      case "no":
        return <Badge className="bg-red-100 text-red-700 text-xs">No</Badge>
      default:
        return null
    }
  }

  if (todaysTours.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Car className="h-4 w-4 text-orange-500" />
            Today's Tours
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground text-center py-4">
            No tours scheduled for today
          </p>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Car className="h-4 w-4 text-orange-500" />
            Today's Tours
          </CardTitle>
          <Badge variant="secondary">{todaysTours.length}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {todaysTours.map((tour) => {
          const buyerName = tour.contacts
            ? `${tour.contacts.first_name || ""} ${tour.contacts.last_name || ""}`.trim()
            : "Buyer"
          const stopCount = tour.tour_stops?.length || 0
          const isExpanded = expandedTourId === tour.id
          const sortedStops = [...(tour.tour_stops || [])].sort(
            (a, b) => a.order_index - b.order_index
          )

          return (
            <div
              key={tour.id}
              className="p-3 rounded-lg border bg-orange-50/50 border-orange-100"
            >
              {/* Tour Header */}
              <div
                className="flex items-center justify-between cursor-pointer"
                onClick={() => setExpandedTourId(isExpanded ? null : tour.id)}
              >
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{buyerName}'s Tour</p>
                  <div className="flex items-center gap-2 mt-1">
                    <Badge variant="outline" className="text-xs">
                      <MapPin className="h-3 w-3 mr-1" />
                      {stopCount} stops
                    </Badge>
                    <Badge
                      variant={tour.status === "in_progress" ? "default" : "secondary"}
                      className="text-xs"
                    >
                      {tour.status === "in_progress" ? "In Progress" : "Scheduled"}
                    </Badge>
                  </div>
                </div>
                <Button
                  size="sm"
                  className="bg-orange-600 hover:bg-orange-700"
                  onClick={(e) => {
                    e.stopPropagation()
                    handleStartTour(tour.id)
                  }}
                >
                  <Play className="h-4 w-4 mr-1" />
                  Start
                </Button>
              </div>

              {/* Expanded Tour Stops */}
              {isExpanded && sortedStops.length > 0 && (
                <div className="mt-3 pt-3 border-t space-y-2">
                  {sortedStops.map((stop, index) => (
                    <div
                      key={stop.id}
                      className="flex items-start gap-3 p-2 bg-background rounded-lg"
                    >
                      <div className="flex flex-col items-center">
                        <div className="w-6 h-6 rounded-full bg-orange-100 flex items-center justify-center text-xs font-semibold text-orange-700">
                          {index + 1}
                        </div>
                        {stop.drive_time_from_prev_minutes && index > 0 && (
                          <span className="text-[10px] text-muted-foreground mt-1">
                            {stop.drive_time_from_prev_minutes}m
                          </span>
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{stop.property_address}</p>
                        <div className="flex items-center gap-2 mt-1 flex-wrap">
                          {stop.list_price && (
                            <span className="text-xs text-muted-foreground">
                              ${stop.list_price.toLocaleString()}
                            </span>
                          )}
                          {stop.suggested_time && (
                            <span className="text-xs text-muted-foreground">
                              @ {stop.suggested_time}
                            </span>
                          )}
                          {getInterestBadge(stop.buyer_interest_level)}
                        </div>
                        {stop.access_code && (
                          <p className="text-xs text-blue-600 mt-1">
                            Code: {stop.access_code}
                          </p>
                        )}
                      </div>
                      <div className="flex gap-1">
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7"
                          onClick={() =>
                            handleGetDirections(stop.property_address, stop.city, stop.state)
                          }
                        >
                          <Navigation className="h-3 w-3 text-blue-600" />
                        </Button>
                        {stop.listing_agent_phone && (
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7"
                            onClick={() => handleCallAgent(stop.listing_agent_phone!)}
                          >
                            <Phone className="h-3 w-3 text-green-600" />
                          </Button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}
