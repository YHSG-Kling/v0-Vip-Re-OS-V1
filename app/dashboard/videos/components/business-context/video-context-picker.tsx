"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { createClient } from "@/lib/supabase/client"
import { Home, User, MapPin, Loader2 } from "lucide-react"
import type { VideoPurpose } from "./video-business-purpose-picker"

type ContextType = "listing" | "contact" | "homeowner" | "market" | "none"

interface VideoContextPickerProps {
  purpose: VideoPurpose | null
  brokerageId: string
  agentId: string
  selectedContextId: string
  selectedContextType: ContextType
  onSelectContext: (id: string, type: ContextType, data: any) => void
}

export function VideoContextPicker({
  purpose,
  brokerageId,
  agentId,
  selectedContextId,
  selectedContextType,
  onSelectContext,
}: VideoContextPickerProps) {
  const supabase = createClient()
  const [listings, setListings] = useState<any[]>([])
  const [contacts, setContacts] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [marketArea, setMarketArea] = useState("")

  // Determine what context is needed based on purpose
  const requiredContext = getRequiredContext(purpose)

  useEffect(() => {
    if (!brokerageId) return

    async function loadContextOptions() {
      setLoading(true)
      try {
        if (requiredContext === "listing") {
          const { data } = await supabase
            .from("listings")
            .select("id, address, city, state, list_price, lifecycle_stage")
            .eq("brokerage_id", brokerageId)
            .in("lifecycle_stage", ["ACTIVE", "COMING_SOON", "PREP"])
            .order("created_at", { ascending: false })
            .limit(50)
          setListings(data || [])
        }

        if (requiredContext === "contact" || requiredContext === "homeowner") {
          const { data } = await supabase
            .from("contacts")
            .select("id, first_name, last_name, email, contact_type")
            .eq("brokerage_id", brokerageId)
            .eq("agent_id", agentId)
            .order("updated_at", { ascending: false })
            .limit(100)
          setContacts(data || [])
        }
      } catch (err) {
        console.error("Error loading context options:", err)
      } finally {
        setLoading(false)
      }
    }

    loadContextOptions()
  }, [brokerageId, agentId, requiredContext, supabase])

  if (!purpose || requiredContext === "none") {
    return null
  }

  if (loading) {
    return (
      <Card>
        <CardContent className="p-6 flex items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          {requiredContext === "listing" && <Home className="h-4 w-4" />}
          {(requiredContext === "contact" || requiredContext === "homeowner") && <User className="h-4 w-4" />}
          {requiredContext === "market" && <MapPin className="h-4 w-4" />}
          Select {requiredContext === "homeowner" ? "Homeowner" : requiredContext.charAt(0).toUpperCase() + requiredContext.slice(1)}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {requiredContext === "listing" && (
          <div className="space-y-2">
            <Label>Which listing is this video about?</Label>
            <Select
              value={selectedContextId}
              onValueChange={(id) => {
                const listing = listings.find((l) => l.id === id)
                onSelectContext(id, "listing", listing)
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select a listing" />
              </SelectTrigger>
              <SelectContent>
                {listings.map((listing) => (
                  <SelectItem key={listing.id} value={listing.id}>
                    <div className="flex items-center gap-2">
                      <span>{listing.address}, {listing.city}</span>
                      <Badge variant="outline" className="text-xs">
                        ${(listing.list_price / 1000).toFixed(0)}K
                      </Badge>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {(requiredContext === "contact" || requiredContext === "homeowner") && (
          <div className="space-y-2">
            <Label>
              {requiredContext === "homeowner"
                ? "Which homeowner should receive this update?"
                : "Who is this video for?"}
            </Label>
            <Select
              value={selectedContextId}
              onValueChange={(id) => {
                const contact = contacts.find((c) => c.id === id)
                onSelectContext(id, requiredContext, contact)
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder={`Select a ${requiredContext}`} />
              </SelectTrigger>
              <SelectContent>
                {contacts
                  .filter((c) =>
                    requiredContext === "homeowner"
                      ? c.contact_type === "homeowner" || c.contact_type === "past_client"
                      : true
                  )
                  .map((contact) => (
                    <SelectItem key={contact.id} value={contact.id}>
                      {contact.first_name} {contact.last_name}
                      {contact.email && (
                        <span className="text-muted-foreground ml-2 text-xs">
                          ({contact.email})
                        </span>
                      )}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {requiredContext === "market" && (
          <div className="space-y-2">
            <Label>Market Area / Neighborhood</Label>
            <Input
              value={marketArea}
              onChange={(e) => {
                setMarketArea(e.target.value)
                onSelectContext(e.target.value, "market", { area: e.target.value })
              }}
              placeholder="e.g., Downtown Austin, Miami Beach"
            />
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function getRequiredContext(purpose: VideoPurpose | null): ContextType {
  switch (purpose) {
    case "listing_launch":
    case "seller_update":
      return "listing"
    case "portal_video":
      return "contact"
    case "homeowner_update":
      return "homeowner"
    case "market_update":
      return "market"
    default:
      return "none"
  }
}
