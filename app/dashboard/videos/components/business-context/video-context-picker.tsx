"use client"

import { useState, useEffect, useRef } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { createClient } from "@/lib/supabase/client"
import { Home, User, MapPin, Loader2, Search, X } from "lucide-react"
import Link from "next/link"
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

const LIFECYCLE_LABEL: Record<string, string> = {
  ACTIVE:           "Active",
  COMING_SOON:      "Coming Soon",
  PREP:             "Prep",
  PENDING:          "Pending",
  UNDER_CONTRACT:   "Under Contract",
  SOLD:             "Sold",
}

const LIFECYCLE_COLOR: Record<string, string> = {
  ACTIVE:           "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  COMING_SOON:      "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  PREP:             "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300",
  PENDING:          "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300",
  UNDER_CONTRACT:   "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300",
  SOLD:             "bg-gray-100 text-gray-800 dark:bg-gray-800/50 dark:text-gray-300",
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

  // Listing combobox state
  const [listingQuery, setListingQuery] = useState("")
  const [comboOpen, setComboOpen] = useState(false)
  const [selectedListing, setSelectedListing] = useState<any>(null)
  const comboRef = useRef<HTMLDivElement>(null)

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
            .in("lifecycle_stage", ["ACTIVE", "COMING_SOON", "PREP", "PENDING", "SOLD", "UNDER_CONTRACT"])
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

  // Sync selectedListing from selectedContextId prop
  useEffect(() => {
    if (!selectedContextId || selectedContextType !== "listing") {
      setSelectedListing(null)
      return
    }
    // Find the listing in the already-loaded listings array
    const found = listings.find(l => l.id === selectedContextId)
    if (found) setSelectedListing(found)
  }, [selectedContextId, selectedContextType, listings])

  // Close combobox on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (comboRef.current && !comboRef.current.contains(e.target as Node)) {
        setComboOpen(false)
      }
    }
    document.addEventListener("mousedown", handleClickOutside)
    return () => document.removeEventListener("mousedown", handleClickOutside)
  }, [])

  // Filter listings by query (address + city + state)
  const filteredListings = listings.filter((l) => {
    if (!listingQuery.trim()) return true
    const q = listingQuery.toLowerCase()
    return (
      l.address?.toLowerCase().includes(q) ||
      l.city?.toLowerCase().includes(q) ||
      l.state?.toLowerCase().includes(q)
    )
  })

  const handleSelectListing = (listing: any) => {
    setSelectedListing(listing)
    setListingQuery("")
    setComboOpen(false)
    onSelectContext(listing.id, "listing", listing)
  }

  const handleClearListing = () => {
    setSelectedListing(null)
    setListingQuery("")
    onSelectContext("", "listing", null)
  }

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

            {/* Selected listing display */}
            {selectedListing ? (
              <div className="flex items-center justify-between gap-2 rounded-md border border-input bg-muted/40 px-3 py-2">
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  <Home className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <span className="text-sm font-medium truncate">
                    {selectedListing.address}, {selectedListing.city}
                  </span>
                  {selectedListing.lifecycle_stage && (
                    <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium shrink-0 ${LIFECYCLE_COLOR[selectedListing.lifecycle_stage] ?? "bg-muted text-muted-foreground"}`}>
                      {LIFECYCLE_LABEL[selectedListing.lifecycle_stage] ?? selectedListing.lifecycle_stage}
                    </span>
                  )}
                  {selectedListing.list_price && (
                    <Badge variant="outline" className="text-xs shrink-0">
                      ${(selectedListing.list_price / 1000).toFixed(0)}K
                    </Badge>
                  )}
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 shrink-0"
                  onClick={handleClearListing}
                  aria-label="Clear selection"
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            ) : (
              /* Searchable combobox */
              <div ref={comboRef} className="relative">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
                  <Input
                    value={listingQuery}
                    onChange={(e) => {
                      setListingQuery(e.target.value)
                      setComboOpen(true)
                    }}
                    onFocus={() => setComboOpen(true)}
                    placeholder="Search by address, city, or state..."
                    className="pl-9"
                  />
                </div>

                {comboOpen && (
                  <div className="absolute z-50 mt-1 w-full rounded-md border border-border bg-popover shadow-md max-h-64 overflow-y-auto">
                    {filteredListings.length === 0 ? (
                      <div className="flex flex-col items-center gap-2 px-4 py-6 text-center">
                        <p className="text-sm text-muted-foreground">
                          {listingQuery.trim()
                            ? `No listings match "${listingQuery}"`
                            : "No listings available."}
                        </p>
                        <Link
                          href="/dashboard/listings/new"
                          className="text-xs text-primary underline-offset-2 hover:underline"
                          onClick={() => setComboOpen(false)}
                        >
                          Create your first listing to use in videos →
                        </Link>
                      </div>
                    ) : (
                      filteredListings.map((listing) => (
                        <button
                          key={listing.id}
                          type="button"
                          className="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-accent hover:text-accent-foreground transition-colors"
                          onClick={() => handleSelectListing(listing)}
                        >
                          <Home className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium truncate">
                              {listing.address}
                            </p>
                            <p className="text-xs text-muted-foreground truncate">
                              {listing.city}{listing.state ? `, ${listing.state}` : ""}
                            </p>
                          </div>
                          <div className="flex items-center gap-1.5 shrink-0">
                            {listing.list_price && (
                              <Badge variant="outline" className="text-xs">
                                ${(listing.list_price / 1000).toFixed(0)}K
                              </Badge>
                            )}
                            {listing.lifecycle_stage && (
                              <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${LIFECYCLE_COLOR[listing.lifecycle_stage] ?? "bg-muted text-muted-foreground"}`}>
                                {LIFECYCLE_LABEL[listing.lifecycle_stage] ?? listing.lifecycle_stage}
                              </span>
                            )}
                          </div>
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>
            )}
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
