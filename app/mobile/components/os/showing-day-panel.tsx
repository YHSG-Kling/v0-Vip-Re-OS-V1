"use client"

import { useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { MapPin, Clock, Phone, Navigation, CheckCircle, Home, ChevronRight } from "lucide-react"
import { format } from "date-fns"
import { toast } from "sonner"
import { completeShowing } from "@/app/actions/showings"

interface Showing {
  id: string
  listing_id?: string
  contact_id?: string
  scheduled_at?: string
  scheduled_date?: string
  scheduled_time?: string
  status: string
  property_address?: string
  buyer_agent_name?: string
  buyer_agent_phone?: string
  notes?: string
  contacts?: {
    first_name?: string
    last_name?: string
    phone?: string
  }
  listings?: {
    address?: string
    city?: string
    state?: string
    list_price?: number
  }
}

interface ShowingDayPanelProps {
  showings: Showing[]
  onShowingSelect?: (showingId: string) => void
}

export function ShowingDayPanel({ showings, onShowingSelect }: ShowingDayPanelProps) {
  const [isPending, startTransition] = useTransition()
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const todaysShowings = showings.filter((s) => {
    const showingDate = s.scheduled_date || s.scheduled_at?.split("T")[0]
    const today = new Date().toISOString().split("T")[0]
    return showingDate === today && s.status !== "cancelled"
  })

  const sortedShowings = [...todaysShowings].sort((a, b) => {
    const timeA = a.scheduled_time || a.scheduled_at?.split("T")[1] || ""
    const timeB = b.scheduled_time || b.scheduled_at?.split("T")[1] || ""
    return timeA.localeCompare(timeB)
  })

  const handleCompleteShowing = (showingId: string) => {
    startTransition(async () => {
      const result = await completeShowing(showingId)
      if (result.success) {
        toast.success("Showing marked as completed")
      } else {
        toast.error("Failed to update showing")
      }
    })
  }

  const handleGetDirections = (address: string) => {
    const encodedAddress = encodeURIComponent(address)
    window.open(`https://maps.google.com/maps?daddr=${encodedAddress}`, "_blank")
  }

  const handleCallAgent = (phone: string) => {
    window.location.href = `tel:${phone}`
  }

  if (sortedShowings.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Home className="h-4 w-4 text-blue-500" />
            Today's Showings
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground text-center py-4">
            No showings scheduled for today
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
            <Home className="h-4 w-4 text-blue-500" />
            Today's Showings
          </CardTitle>
          <Badge variant="secondary">{sortedShowings.length}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {sortedShowings.map((showing, index) => {
          const address =
            showing.property_address ||
            showing.listings?.address ||
            "Address TBD"
          const time = showing.scheduled_time || 
            (showing.scheduled_at ? format(new Date(showing.scheduled_at), "h:mm a") : "TBD")
          const buyerName = showing.contacts
            ? `${showing.contacts.first_name || ""} ${showing.contacts.last_name || ""}`.trim()
            : showing.buyer_agent_name || "Buyer"
          const buyerPhone = showing.contacts?.phone || showing.buyer_agent_phone
          const isExpanded = expandedId === showing.id
          const isCompleted = showing.status === "completed"

          return (
            <div
              key={showing.id}
              className={`p-3 rounded-lg border transition-all ${
                isCompleted ? "bg-green-50 border-green-200" : "bg-muted/30"
              }`}
            >
              {/* Main Row */}
              <div
                className="flex items-center justify-between cursor-pointer"
                onClick={() => setExpandedId(isExpanded ? null : showing.id)}
              >
                <div className="flex items-center gap-3">
                  <div className="flex flex-col items-center justify-center w-12 h-12 bg-background rounded-lg border">
                    <span className="text-xs text-muted-foreground">#{index + 1}</span>
                    <span className="text-sm font-semibold">{time}</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{address}</p>
                    <p className="text-xs text-muted-foreground">{buyerName}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {isCompleted && <CheckCircle className="h-4 w-4 text-green-600" />}
                  <ChevronRight
                    className={`h-4 w-4 text-muted-foreground transition-transform ${
                      isExpanded ? "rotate-90" : ""
                    }`}
                  />
                </div>
              </div>

              {/* Expanded Actions */}
              {isExpanded && (
                <div className="mt-3 pt-3 border-t space-y-2">
                  <div className="grid grid-cols-3 gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      className="flex flex-col items-center gap-1 h-auto py-2"
                      onClick={() => handleGetDirections(address)}
                    >
                      <Navigation className="h-4 w-4 text-blue-600" />
                      <span className="text-xs">Directions</span>
                    </Button>
                    {buyerPhone && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="flex flex-col items-center gap-1 h-auto py-2"
                        onClick={() => handleCallAgent(buyerPhone)}
                      >
                        <Phone className="h-4 w-4 text-green-600" />
                        <span className="text-xs">Call</span>
                      </Button>
                    )}
                    {!isCompleted && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="flex flex-col items-center gap-1 h-auto py-2"
                        onClick={() => handleCompleteShowing(showing.id)}
                        disabled={isPending}
                      >
                        <CheckCircle className="h-4 w-4 text-green-600" />
                        <span className="text-xs">Complete</span>
                      </Button>
                    )}
                  </div>
                  {showing.notes && (
                    <p className="text-xs text-muted-foreground bg-muted/50 p-2 rounded">
                      {showing.notes}
                    </p>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}
