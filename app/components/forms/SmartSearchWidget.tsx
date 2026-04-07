"use client"

// app/components/forms/SmartSearchWidget.tsx
// ═══════════════════════════════════════════════════════════════════════════════
// BUYER SMART PROPERTY SEARCH WIDGET (PORTAL)
// ═══════════════════════════════════════════════════════════════════════════════
//
// EXPLICIT RULES:
//   • Contact is the actor — all property actions go through recordPropertyActionAction
//   • interest_level transitions enforced by kernel: dismissed → offer_requested is blocked
//   • No direct DB writes from this component
//   • NL search triggers are sent to /api/search/buyer-smart-search (GET with q= param)
//     Falls back to static saved properties if no search query
//   • Property cards show: photo, address, price, beds, baths
//   • Action buttons: "Save", "Dismiss", "Request Tour", "Start Offer"
//
// EXPLICIT UI BEHAVIOR:
//   • Search input + "Search" button — not auto-search on keystroke
//   • Results replace the saved properties list when a search is active
//   • Each result has 4 action buttons with clear icons
//   • Saved properties are shown when no search is active
//   • Optimistic state: button reflects new interest_level immediately

import { useState, useTransition, useCallback } from "react"
import useSWR from "swr"
import {
  Heart, ThumbsDown, MapPin, BedDouble, Bath,
  Search, Home, Loader2, Check, CalendarClock, FileText
} from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/app/components/ui/card"
import { Button } from "@/app/components/ui/button"
import { Input } from "@/app/components/ui/input"
import { Badge } from "@/app/components/ui/badge"
import { Skeleton } from "@/app/components/ui/skeleton"
import { cn } from "@/lib/utils"
import { recordPropertyActionAction, loadBuyerPropertiesAction } from "@/app/actions/forms-kernel"
import type { BuyerPropertyInterestLevel, BuyerPropertyInterest } from "@/lib/kernel/forms"

// ─── TYPES ───────────────────────────────────────────────────────────────────

interface SmartSearchWidgetProps {
  contactId: string
  /** Optional pre-loaded property preferences from parent server component */
  preferences?: {
    min_price?: number | null
    max_price?: number | null
    min_beds?: number | null
    min_baths?: number | null
    zip_codes?: string[] | null
    property_types?: string[] | null
  } | null
  className?: string
}

interface PropertyResult {
  id:                string
  address?:          string
  property_address?: string
  list_price?:       number
  bedrooms?:         number
  bathrooms?:        number
  primary_photo_url?: string
  current_interest?: BuyerPropertyInterestLevel
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function displayAddress(p: PropertyResult) {
  return p.address ?? p.property_address ?? "Address not available"
}

function formatPrice(price?: number) {
  if (!price) return "Price N/A"
  return `$${price.toLocaleString()}`
}

const fetcher = (url: string) =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error("Search failed")
    return r.json()
  })

// ─── PROPERTY CARD ────────────────────────────────────────────────────────────

function PropertyCard({
  property,
  onAction,
  pendingAction,
}: {
  property:      PropertyResult
  onAction:      (listingId: string, level: BuyerPropertyInterestLevel) => void
  pendingAction: string | null
}) {
  const current    = property.current_interest
  const isLoading  = pendingAction === property.id
  const isSaved    = current === "saved" || current === "favorited"
  const isDismissed = current === "dismissed" || current === "not_interested"
  const isOffer    = current === "offer_requested"
  const isTour     = current === "tour_requested"

  return (
    <div className="flex gap-3 p-3 rounded-lg border bg-card hover:bg-accent/30 transition-colors">
      {/* Photo */}
      <div className="h-16 w-20 rounded-md bg-muted shrink-0 overflow-hidden">
        {property.primary_photo_url ? (
          <img
            src={property.primary_photo_url}
            alt={displayAddress(property)}
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="h-full w-full flex items-center justify-center">
            <Home className="h-6 w-6 text-muted-foreground" />
          </div>
        )}
      </div>

      {/* Details */}
      <div className="flex-1 min-w-0 space-y-1">
        <p className="text-sm font-medium truncate">{displayAddress(property)}</p>
        <p className="text-sm font-semibold text-primary">{formatPrice(property.list_price)}</p>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          {property.bedrooms && (
            <span className="flex items-center gap-1">
              <BedDouble className="h-3 w-3" />
              {property.bedrooms} bd
            </span>
          )}
          {property.bathrooms && (
            <span className="flex items-center gap-1">
              <Bath className="h-3 w-3" />
              {property.bathrooms} ba
            </span>
          )}
        </div>
      </div>

      {/* Action buttons */}
      <div className="flex flex-col gap-1 shrink-0">
        {isLoading ? (
          <div className="flex items-center justify-center h-full w-8">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            <Button
              variant={isSaved ? "default" : "ghost"}
              size="sm"
              className={cn("h-7 w-7 p-0", isSaved && "bg-rose-500 hover:bg-rose-600 border-0")}
              onClick={() => onAction(property.id, isSaved ? "dismissed" : "saved")}
              title={isSaved ? "Remove from saved" : "Save property"}
            >
              <Heart className={cn("h-3.5 w-3.5", isSaved && "fill-white text-white")} />
            </Button>
            <Button
              variant={isTour ? "default" : "ghost"}
              size="sm"
              className="h-7 w-7 p-0"
              onClick={() => onAction(property.id, "tour_requested")}
              title="Request a tour"
            >
              {isTour ? <Check className="h-3.5 w-3.5" /> : <CalendarClock className="h-3.5 w-3.5" />}
            </Button>
            <Button
              variant={isOffer ? "default" : "ghost"}
              size="sm"
              className="h-7 w-7 p-0"
              onClick={() => onAction(property.id, "offer_requested")}
              title="Request to start an offer"
              disabled={isDismissed}
            >
              {isOffer ? <Check className="h-3.5 w-3.5" /> : <FileText className="h-3.5 w-3.5" />}
            </Button>
            <Button
              variant={isDismissed ? "secondary" : "ghost"}
              size="sm"
              className="h-7 w-7 p-0"
              onClick={() => onAction(property.id, isDismissed ? "saved" : "dismissed")}
              title={isDismissed ? "Restore property" : "Not interested"}
            >
              <ThumbsDown className={cn("h-3.5 w-3.5", isDismissed && "text-muted-foreground")} />
            </Button>
          </>
        )}
      </div>
    </div>
  )
}

// ─── MAIN COMPONENT ──────────────────────────────────────────────────────────

export function SmartSearchWidget({ contactId, preferences, className }: SmartSearchWidgetProps) {
  const [query, setQuery]           = useState("")
  const [activeQuery, setActiveQuery] = useState("")
  const [pendingAction, setPendingAction] = useState<string | null>(null)
  const [isPending, startTransition]  = useTransition()

  // Optimistic interest state: listingId → interest_level
  const [optimisticInterests, setOptimisticInterests] = useState<
    Record<string, BuyerPropertyInterestLevel>
  >({})

  // Saved properties (shown when no active search)
  const { data: savedData, mutate: mutateSaved, isLoading: isLoadingSaved } = useSWR(
    `buyer-properties-${contactId}`,
    () =>
      loadBuyerPropertiesAction({ contact_id: contactId, limit: 20 }).then((r) =>
        r.success ? r.data?.interests ?? [] : []
      ),
    { revalidateOnFocus: false }
  )

  // Search results
  const { data: searchData, isLoading: isSearching } = useSWR<{
    results?: PropertyResult[]
    total?: number
  }>(
    activeQuery
      ? `/api/search/buyer-smart-search?q=${encodeURIComponent(activeQuery)}&contact_id=${contactId}`
      : null,
    fetcher,
    { revalidateOnFocus: false }
  )

  // ── Merge optimistic state into results ───────────────────────────────────
  const enrichWithOptimistic = useCallback(
    (items: PropertyResult[]): PropertyResult[] =>
      items.map((item) => ({
        ...item,
        current_interest: optimisticInterests[item.id] ?? item.current_interest,
      })),
    [optimisticInterests]
  )

  // Convert saved BuyerPropertyInterest → PropertyResult
  const savedAsResults: PropertyResult[] = (savedData ?? []).map(
    (interest: BuyerPropertyInterest) => ({
      id:                interest.listing_id,
      address:           interest.listing?.address,
      property_address:  interest.listing?.property_address,
      list_price:        interest.listing?.list_price,
      bedrooms:          interest.listing?.bedrooms,
      bathrooms:         interest.listing?.bathrooms,
      primary_photo_url: interest.listing?.primary_photo_url,
      current_interest:  interest.interest_level,
    })
  )

  const displayResults = activeQuery
    ? enrichWithOptimistic(searchData?.results ?? [])
    : enrichWithOptimistic(savedAsResults)

  // ── Handle property action ────────────────────────────────────────────────
  const handleAction = useCallback(
    (listingId: string, level: BuyerPropertyInterestLevel) => {
      setPendingAction(listingId)
      // Optimistic update
      setOptimisticInterests((prev) => ({ ...prev, [listingId]: level }))

      startTransition(async () => {
        await recordPropertyActionAction({ contact_id: contactId, listing_id: listingId, interest_level: level })
        setPendingAction(null)
        mutateSaved()
      })
    },
    [contactId, mutateSaved]
  )

  // ── Handle search ─────────────────────────────────────────────────────────
  const handleSearch = () => {
    setActiveQuery(query.trim())
  }

  const handleClearSearch = () => {
    setQuery("")
    setActiveQuery("")
  }

  return (
    <Card className={className}>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Search className="h-4 w-4" />
          Property Search
        </CardTitle>
        <CardDescription className="text-xs">
          Search by neighborhood, address, or criteria — or review your saved properties.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Search bar */}
        <div className="flex gap-2">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            placeholder="e.g. 3 bed near downtown under $500k"
            className="h-9 text-sm"
          />
          <Button size="sm" onClick={handleSearch} disabled={!query.trim() || isSearching} className="h-9 shrink-0">
            {isSearching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
          </Button>
        </div>

        {/* Active search badge */}
        {activeQuery && (
          <div className="flex items-center gap-2">
            <Badge variant="secondary" className="text-xs">
              <Search className="h-3 w-3 mr-1" />
              {activeQuery}
            </Badge>
            <Button variant="ghost" size="sm" className="h-6 text-xs px-2" onClick={handleClearSearch}>
              Clear
            </Button>
          </div>
        )}

        {/* Results / saved list */}
        <div className="space-y-2">
          {(isLoadingSaved && !activeQuery) || (isSearching && activeQuery) ? (
            <>
              {[1, 2, 3].map((i) => (
                <div key={i} className="flex gap-3 p-3 rounded-lg border">
                  <Skeleton className="h-16 w-20 rounded-md shrink-0" />
                  <div className="flex-1 space-y-2 pt-1">
                    <Skeleton className="h-4 w-3/4" />
                    <Skeleton className="h-4 w-1/4" />
                    <Skeleton className="h-3 w-1/3" />
                  </div>
                </div>
              ))}
            </>
          ) : displayResults.length === 0 ? (
            <div className="text-center py-8 space-y-2">
              <MapPin className="h-8 w-8 text-muted-foreground mx-auto" />
              <p className="text-sm font-medium text-muted-foreground">
                {activeQuery ? "No properties found for this search" : "No saved properties yet"}
              </p>
              <p className="text-xs text-muted-foreground">
                {activeQuery
                  ? "Try a different search term or ask your agent to configure property alerts."
                  : "Use the search above or ask your agent to share properties with you."}
              </p>
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between text-xs text-muted-foreground px-0.5">
                <span>
                  {activeQuery
                    ? `${displayResults.length} result${displayResults.length !== 1 ? "s" : ""}`
                    : `${displayResults.length} saved propert${displayResults.length !== 1 ? "ies" : "y"}`}
                </span>
                {!activeQuery && (
                  <div className="flex items-center gap-3 text-[10px]">
                    <span className="flex items-center gap-1"><Heart className="h-2.5 w-2.5 text-rose-500" /> Save</span>
                    <span className="flex items-center gap-1"><CalendarClock className="h-2.5 w-2.5" /> Tour</span>
                    <span className="flex items-center gap-1"><FileText className="h-2.5 w-2.5" /> Offer</span>
                    <span className="flex items-center gap-1"><ThumbsDown className="h-2.5 w-2.5" /> Pass</span>
                  </div>
                )}
              </div>
              {displayResults.map((property) => (
                <PropertyCard
                  key={property.id}
                  property={property}
                  onAction={handleAction}
                  pendingAction={pendingAction}
                />
              ))}
            </>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
