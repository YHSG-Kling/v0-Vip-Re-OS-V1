"use client"

import { useState, useEffect, useRef, useTransition, useCallback } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { Button }    from "@/components/ui/button"
import { Input }     from "@/components/ui/input"
import { Badge }     from "@/components/ui/badge"
import { cn }        from "@/lib/utils"
import { searchProperties, smartSearch } from "@/app/actions/idx-search"
import { isTourAllowed }                 from "@/lib/buyer-lifecycle/gating-helpers"
import { requestShowing }                from "@/app/actions/showings"
import { createClient }                  from "@/lib/supabase/client"
import { useToast }                      from "@/hooks/use-toast"

// ─── TYPES ────────────────────────────────────────────────────────────────────

interface Property {
  id?:               string
  mls_number?:       string
  address?:          string
  city?:             string
  state?:            string
  list_price?:       number
  bedrooms?:         number
  bathrooms?:        number
  sqft?:             number
  days_on_market?:   number
  property_type?:    string
  primary_photo_url?: string
  ai_match_score?:   number
  match_reasons?:    string[]
}

interface Filters {
  minPrice:    string
  maxPrice:    string
  minBeds:     number | null
  minBaths:    string
  propertyTypes: string[]
  cities:      string[]
  zips:        string[]
  maxDom:      string
}

interface SearchClientProps {
  buyerId:          string
  brokerageId:      string
  agentUserId:      string
  initialInterests: any | null
  buyerPersona:     string | null
}

const BED_OPTIONS  = ["1","2","3","4","5+"]
const BATH_OPTIONS = ["1","1.5","2","3+"]
const PROP_TYPES   = ["single_family","condo","townhouse","multi_family"]

// ─── GATE MODAL ───────────────────────────────────────────────────────────────

function GateModal({ persona, onPrimary, onClose }: { persona: string | null; onPrimary: () => void; onClose: () => void }) {
  const copy = (() => {
    switch (persona) {
      case "analytical":  return { title: "Financial Verification Required",     body: "Verifying your purchasing capacity protects your position in competitive offer situations." }
      case "emotional":   return { title: "One Quick Step Before Scheduling",    body: "Let's make sure you're fully prepared — it creates a much stronger impression with the seller." }
      case "direct":      return { title: "Complete Verification First",         body: "Upload your pre-approval or proof of funds. Takes 2 minutes." }
      default:            return { title: "Before We Schedule",                  body: "We need to verify financing before scheduling showings." }
    }
  })()
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative z-10 w-full max-w-md rounded-xl border border-border bg-card shadow-xl p-6 space-y-4">
        <h2 className="text-base font-semibold">{copy.title}</h2>
        <p className="text-sm text-muted-foreground leading-relaxed">{copy.body}</p>
        <div className="flex gap-3 pt-1">
          <button onClick={onPrimary} className="flex-1 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors">Complete Verification</button>
          <button onClick={onClose}   className="flex-1 rounded-md border border-border px-4 py-2 text-sm text-muted-foreground hover:bg-muted/50 transition-colors">Remind Me Later</button>
        </div>
      </div>
    </div>
  )
}

// ─── PROPERTY CARD ────────────────────────────────────────────────────────────

function PropertyCard({
  property, buyerId, brokerageId, agentUserId, buyerPersona,
  saved, onSave, onDismiss, onSchedule,
}: {
  property:       Property
  buyerId:        string
  brokerageId:    string
  agentUserId:    string
  buyerPersona:   string | null
  saved:          boolean
  onSave:         (p: Property) => void
  onDismiss:      (p: Property) => void
  onSchedule:     (p: Property) => void
}) {
  const cardRef  = useRef<HTMLDivElement>(null)
  const viewedRef = useRef(false)
  const { toast } = useToast()

  // IntersectionObserver — log property_viewed after 2s
  useEffect(() => {
    const el = cardRef.current
    if (!el) return
    let timer: ReturnType<typeof setTimeout>
    const obs = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting && !viewedRef.current) {
        timer = setTimeout(async () => {
          viewedRef.current = true
          const supabase = createClient()
          await supabase.from("buyer_behavior_log").insert({
            brokerage_id:     brokerageId,
            contact_id:       buyerId,
            signal_type:      "property_viewed",
            mls_number:       property.mls_number ?? null,
            property_address: property.address ?? null,
            list_price:       property.list_price ?? null,
            bedrooms:         property.bedrooms  ?? null,
            bathrooms:        property.bathrooms ?? null,
            city:             property.city      ?? null,
            signal_value:     1,
            source:           "agent_dashboard",
          })
        }, 2000)
      } else {
        clearTimeout(timer)
      }
    }, { threshold: 0.5 })
    obs.observe(el)
    return () => { obs.disconnect(); clearTimeout(timer) }
  }, [buyerId, brokerageId, property])

  const price = property.list_price ? `$${property.list_price.toLocaleString()}` : "—"
  const dom   = property.days_on_market

  return (
    <div ref={cardRef} className="rounded-lg border border-border bg-card overflow-hidden flex flex-col">
      {/* Photo */}
      <div className="aspect-[16/9] bg-muted relative overflow-hidden">
        {property.primary_photo_url ? (
          <img src={property.primary_photo_url} alt={property.address ?? "Property"} className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <svg viewBox="0 0 48 48" className="w-10 h-10 text-muted-foreground/30" fill="none">
              <path d="M6 42V20L24 6l18 14v22H30V28H18v14z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"/>
            </svg>
          </div>
        )}
        {dom != null && (
          <span className={cn(
            "absolute top-2 right-2 rounded-md px-1.5 py-0.5 text-[10px] font-medium",
            dom <= 7  ? "bg-green-100 text-green-800" :
            dom <= 30 ? "bg-amber-100 text-amber-800" :
                        "bg-red-100 text-red-800"
          )}>
            {dom}d on market
          </span>
        )}
      </div>

      <div className="p-3 flex flex-col gap-2 flex-1">
        {/* Address + price */}
        <div>
          <p className="text-sm font-semibold leading-tight">{price}</p>
          <p className="text-xs text-muted-foreground">{property.address}{property.city ? `, ${property.city}` : ""}{property.state ? `, ${property.state}` : ""}</p>
        </div>

        {/* Stats */}
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          {property.bedrooms  != null && <span>{property.bedrooms} bd</span>}
          {property.bathrooms != null && <span>{property.bathrooms} ba</span>}
          {property.sqft      != null && <span>{property.sqft.toLocaleString()} sqft</span>}
        </div>

        {/* AI match score */}
        {property.ai_match_score != null && property.ai_match_score > 0 && (
          <div className="space-y-1">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">Match score</span>
              <span className="font-medium">{property.ai_match_score}%</span>
            </div>
            <div className="h-1.5 rounded-full bg-muted overflow-hidden">
              <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${property.ai_match_score}%` }} />
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center gap-2 pt-1 mt-auto">
          <Button
            size="sm"
            variant={saved ? "outline" : "default"}
            className="flex-1 h-7 text-xs"
            onClick={() => onSave(property)}
          >
            {saved ? "Saved" : "Save"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="flex-1 h-7 text-xs"
            onClick={() => onSchedule(property)}
          >
            Schedule
          </Button>
          <button
            onClick={() => onDismiss(property)}
            className="text-muted-foreground hover:text-destructive transition-colors ml-auto"
            aria-label="Dismiss"
          >
            <svg viewBox="0 0 16 16" className="w-4 h-4" fill="none">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── MAIN SEARCH CLIENT ───────────────────────────────────────────────────────

export function SearchClient({
  buyerId, brokerageId, agentUserId, initialInterests, buyerPersona,
}: SearchClientProps) {
  const { toast }    = useToast()
  const [, startTransition] = useTransition()

  const [nlpQuery, setNlpQuery]     = useState("")
  const [interpreting, setInterpreting] = useState(false)
  const [properties, setProperties] = useState<Property[]>([])
  const [loading, setLoading]       = useState(false)
  const [searched, setSearched]     = useState(false)
  const [savedTab, setSavedTab]     = useState(false)
  const [savedIds, setSavedIds]     = useState<Set<string>>(new Set())
  const [showGate, setShowGate]           = useState(false)
  const [savingCriteria, setSavingCriteria] = useState(false)

  // Showing scheduler dialog state
  const [showingDialogOpen, setShowingDialogOpen]     = useState(false)
  const [showingProperty, setShowingProperty]         = useState<Property | null>(null)
  const [showingDate1, setShowingDate1]               = useState("")
  const [showingTime1, setShowingTime1]               = useState("")
  const [showingDate2, setShowingDate2]               = useState("")
  const [showingTime2, setShowingTime2]               = useState("")
  const [showingNotes, setShowingNotes]               = useState("")
  const [showingSubmitting, setShowingSubmitting]     = useState(false)

  const [filters, setFilters] = useState<Filters>({
    minPrice:      initialInterests?.min_price?.toString() ?? "",
    maxPrice:      initialInterests?.max_price?.toString() ?? "",
    minBeds:       initialInterests?.bedrooms ?? null,
    minBaths:      initialInterests?.bathrooms?.toString() ?? "",
    propertyTypes: initialInterests?.property_type ? [initialInterests.property_type] : [],
    cities:        initialInterests?.preferred_locations ?? [],
    zips:          initialInterests?.zip_codes ?? [],
    maxDom:        "",
  })

  const [cityInput, setCityInput] = useState("")
  const [zipInput, setZipInput]   = useState("")

  async function runSearch(overrideFilters?: Partial<Filters>) {
    setLoading(true)
    setSearched(true)
    const f = { ...filters, ...overrideFilters }
    const result = await searchProperties({
      minPrice:     f.minPrice ? Number(f.minPrice) : undefined,
      maxPrice:     f.maxPrice ? Number(f.maxPrice) : undefined,
      beds:         f.minBeds ?? undefined,
      baths:        f.minBaths ? Number(f.minBaths) : undefined,
      propertyType: f.propertyTypes.length ? f.propertyTypes : undefined,
      city:         f.cities.length ? f.cities.join(",") : undefined,
    })
    setLoading(false)
    setProperties(result.properties ?? [])
  }

  async function runSmartSearch() {
    if (!nlpQuery.trim()) return
    setInterpreting(true)
    setSearched(true)
    const result = await smartSearch({ naturalLanguageQuery: nlpQuery, contactId: buyerId })
    setInterpreting(false)
    setProperties(result.properties ?? [])
    if (result.filters) {
      setFilters(prev => ({
        ...prev,
        minPrice:  result.filters.minPrice?.toString() ?? prev.minPrice,
        maxPrice:  result.filters.maxPrice?.toString() ?? prev.maxPrice,
        minBeds:   result.filters.beds ?? prev.minBeds,
        minBaths:  result.filters.baths?.toString() ?? prev.minBaths,
      }))
    }
  }

  async function handleSaveProperty(property: Property) {
    const key = property.mls_number ?? property.id ?? property.address ?? ""
    if (savedIds.has(key)) return
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return

    // Resolve whether this IDX property is a brokerage listing.
    // Only match on mls_number within the same brokerage — listing_id stays null for external MLS properties.
    let resolvedListingId: string | null = null
    if (property.mls_number) {
      const { data: brokerageListing } = await supabase
        .from("listings")
        .select("id")
        .eq("mls_number", property.mls_number)
        .eq("brokerage_id", brokerageId)
        .maybeSingle()
      resolvedListingId = brokerageListing?.id ?? null
    }

    await supabase.from("saved_properties").insert({
      contact_id:        buyerId,
      brokerage_id:      brokerageId,
      user_id:           user.id,
      listing_id:        resolvedListingId,
      notes:             null,
      dismissed:         false,
      // IDX snapshot — stored at save-time so display doesn't need a re-fetch
      property_address:  property.address ?? null,
      mls_number:        property.mls_number ?? null,
      list_price:        property.list_price ?? null,
      bedrooms:          property.bedrooms ?? null,
      bathrooms:         property.bathrooms ?? null,
      sqft:              property.sqft ?? null,
      city:              property.city ?? null,
      state:             property.state ?? null,
      property_type:     property.property_type ?? null,
      primary_photo_url: property.primary_photo_url ?? null,
    })
    await supabase.from("buyer_behavior_log").insert({
      brokerage_id:     brokerageId,
      contact_id:       buyerId,
      signal_type:      "property_saved",
      mls_number:       property.mls_number ?? null,
      property_address: property.address    ?? null,
      list_price:       property.list_price ?? null,
      source:           "agent_dashboard",
    })
    setSavedIds(prev => new Set([...prev, key]))
    toast({ title: "Property saved" })
  }

  async function handleDismissProperty(property: Property) {
    const supabase = createClient()
    await supabase.from("buyer_behavior_log").insert({
      brokerage_id:     brokerageId,
      contact_id:       buyerId,
      signal_type:      "property_dismissed",
      mls_number:       property.mls_number ?? null,
      property_address: property.address    ?? null,
      source:           "agent_dashboard",
    })
    setProperties(prev => prev.filter(p => (p.mls_number ?? p.id) !== (property.mls_number ?? property.id)))
  }

  async function handleScheduleShowing(property: Property) {
    const gateResult = await isTourAllowed(buyerId)
    if (!gateResult.allowed) {
      setShowGate(true)
      return
    }
    setShowingProperty(property)
    setShowingDate1("")
    setShowingTime1("")
    setShowingDate2("")
    setShowingTime2("")
    setShowingNotes("")
    setShowingDialogOpen(true)
  }

  async function handleSubmitShowing() {
    if (!showingProperty || !showingDate1 || !showingTime1) {
      toast({ title: "Please fill in at least one preferred date and time" })
      return
    }
    setShowingSubmitting(true)
    const preferredDates: { date: string; time: string }[] = [{ date: showingDate1, time: showingTime1 }]
    if (showingDate2 && showingTime2) preferredDates.push({ date: showingDate2, time: showingTime2 })

    // showingProperty.id is the listings UUID when this is a brokerage
    // listing; for external (Rentcast/IDX) results only mls_number is present.
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    const propId = showingProperty.id ?? showingProperty.mls_number ?? ""
    const isUuid = typeof propId === "string" && uuidRe.test(propId)

    const result = await requestShowing({
      contactId:        buyerId,
      listingId:        isUuid ? propId : undefined,
      mlsNumber:        showingProperty.mls_number ?? undefined,
      propertyAddress:  showingProperty.address ?? "",
      propertyCity:     (showingProperty as any).city,
      propertyState:    (showingProperty as any).state,
      propertyZip:      (showingProperty as any).zip ?? (showingProperty as any).zip_code,
      listPrice:        (showingProperty as any).list_price ?? (showingProperty as any).price,
      primaryPhotoUrl:  (showingProperty as any).primary_photo_url ?? (showingProperty as any).photo_url,
      source:           'agent_input',
      preferredDates,
      clientNotes:      showingNotes || undefined,
    })
    setShowingSubmitting(false)
    if (result.success) {
      setShowingDialogOpen(false)
      toast({ title: "Showing requested", description: `Request sent for ${showingProperty.address}` })
    } else {
      toast({ title: "Failed to request showing", description: result.error ?? "Please try again" })
    }
  }

  async function handleSaveCriteria() {
    setSavingCriteria(true)
    const supabase = createClient()
    const [interestsResult, preferencesResult] = await Promise.all([
      supabase.from("property_interests").upsert(
        {
          contact_id:          buyerId,
          brokerage_id:        brokerageId,
          agent_user_id:       agentUserId,
          min_price:           filters.minPrice ? Number(filters.minPrice) : null,
          max_price:           filters.maxPrice ? Number(filters.maxPrice) : null,
          bedrooms:            filters.minBeds ?? null,
          bathrooms:           filters.minBaths ? Number(filters.minBaths) : null,
          property_type:       filters.propertyTypes[0] ?? null,
          preferred_locations: filters.cities,
          zip_codes:           filters.zips,
          updated_at:          new Date().toISOString(),
        },
        { onConflict: "contact_id" }
      ),
      // Keep property_preferences in sync so AI matching can read these criteria
      // Column names match the live schema (no preferred_bedrooms/cities — use inferred_ columns)
      supabase.from("property_preferences").upsert(
        {
          contact_id:              buyerId,
          brokerage_id:            brokerageId,
          preferred_price_min:     filters.minPrice ? Number(filters.minPrice) : null,
          preferred_price_max:     filters.maxPrice ? Number(filters.maxPrice) : null,
          inferred_beds_min:       filters.minBeds ?? null,
          inferred_baths_min:      filters.minBaths ? Number(filters.minBaths) : null,
          inferred_cities:         filters.cities.length > 0 ? filters.cities : null,
          inferred_property_types: filters.propertyTypes.length > 0 ? filters.propertyTypes : null,
          updated_at:              new Date().toISOString(),
        },
        { onConflict: "contact_id" }
      ),
    ])
    setSavingCriteria(false)
    if (interestsResult.error || preferencesResult.error) {
      toast({
        title: "Failed to save search criteria",
        description: interestsResult.error?.message ?? preferencesResult.error?.message ?? "Please try again",
      })
    } else {
      toast({ title: "Search criteria saved" })
    }
  }

  function togglePropType(type: string) {
    setFilters(prev => ({
      ...prev,
      propertyTypes: prev.propertyTypes.includes(type)
        ? prev.propertyTypes.filter(t => t !== type)
        : [...prev.propertyTypes, type],
    }))
  }

  function addCity() {
    const v = cityInput.trim()
    if (v && !filters.cities.includes(v)) {
      setFilters(prev => ({ ...prev, cities: [...prev.cities, v] }))
    }
    setCityInput("")
  }

  function addZip() {
    const v = zipInput.trim()
    if (v && !filters.zips.includes(v)) {
      setFilters(prev => ({ ...prev, zips: [...prev.zips, v] }))
    }
    setZipInput("")
  }

  return (
    <>
      {showGate && (
        <GateModal
          persona={buyerPersona}
          onPrimary={() => { window.history.back(); setShowGate(false) }}
          onClose={() => setShowGate(false)}
        />
      )}

      {/* Showing scheduler dialog */}
      {showingDialogOpen && showingProperty && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/40" onClick={() => setShowingDialogOpen(false)} />
          <div className="relative z-10 w-full max-w-md rounded-xl border border-border bg-card shadow-xl p-6 space-y-4">
            <h2 className="text-base font-semibold">Request a Showing</h2>
            <p className="text-sm text-muted-foreground">{showingProperty.address}{showingProperty.city ? `, ${showingProperty.city}` : ""}</p>

            <div className="space-y-3">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Preferred Date &amp; Time #1</p>
              <div className="flex gap-2">
                <input
                  type="date"
                  value={showingDate1}
                  onChange={e => setShowingDate1(e.target.value)}
                  min={new Date().toISOString().split("T")[0]}
                  className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                />
                <input
                  type="time"
                  value={showingTime1}
                  onChange={e => setShowingTime1(e.target.value)}
                  className="w-28 rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>

              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Alternate Date &amp; Time (optional)</p>
              <div className="flex gap-2">
                <input
                  type="date"
                  value={showingDate2}
                  onChange={e => setShowingDate2(e.target.value)}
                  min={new Date().toISOString().split("T")[0]}
                  className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                />
                <input
                  type="time"
                  value={showingTime2}
                  onChange={e => setShowingTime2(e.target.value)}
                  className="w-28 rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>

              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Notes for agent (optional)</p>
                <textarea
                  rows={2}
                  value={showingNotes}
                  onChange={e => setShowingNotes(e.target.value)}
                  placeholder="Any specific questions, accessibility needs, etc."
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary resize-none"
                />
              </div>
            </div>

            <div className="flex gap-3 pt-1">
              <button
                onClick={handleSubmitShowing}
                disabled={showingSubmitting}
                className="flex-1 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
              >
                {showingSubmitting ? "Submitting..." : "Request Showing"}
              </button>
              <button
                onClick={() => setShowingDialogOpen(false)}
                className="flex-1 rounded-md border border-border px-4 py-2 text-sm text-muted-foreground hover:bg-muted/50 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="flex flex-1 min-h-0 h-full">
        {/* Filter sidebar */}
        <aside className="w-[280px] flex-shrink-0 border-r border-border overflow-y-auto px-4 py-5 space-y-5">
          <h3 className="text-sm font-semibold">Filters</h3>

          {/* Price range */}
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">Price range</p>
            <div className="flex items-center gap-2">
              <Input placeholder="Min" type="number" value={filters.minPrice} onChange={e => setFilters(f => ({ ...f, minPrice: e.target.value }))} className="h-8 text-xs" />
              <span className="text-muted-foreground text-xs">–</span>
              <Input placeholder="Max" type="number" value={filters.maxPrice} onChange={e => setFilters(f => ({ ...f, maxPrice: e.target.value }))} className="h-8 text-xs" />
            </div>
          </div>

          {/* Beds */}
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">Min beds</p>
            <div className="flex gap-1.5 flex-wrap">
              {BED_OPTIONS.map(b => (
                <button
                  key={b}
                  onClick={() => setFilters(f => ({ ...f, minBeds: f.minBeds === Number(b.replace("+","")) ? null : Number(b.replace("+","")) }))}
                  className={cn(
                    "rounded-md border px-2.5 py-1 text-xs transition-colors",
                    filters.minBeds === Number(b.replace("+",""))
                      ? "border-primary bg-primary/5 text-primary"
                      : "border-border text-muted-foreground hover:border-foreground/30"
                  )}
                >
                  {b}
                </button>
              ))}
            </div>
          </div>

          {/* Baths */}
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">Min baths</p>
            <div className="flex gap-1.5 flex-wrap">
              {BATH_OPTIONS.map(b => (
                <button
                  key={b}
                  onClick={() => setFilters(f => ({ ...f, minBaths: f.minBaths === b ? "" : b }))}
                  className={cn(
                    "rounded-md border px-2.5 py-1 text-xs transition-colors",
                    filters.minBaths === b
                      ? "border-primary bg-primary/5 text-primary"
                      : "border-border text-muted-foreground hover:border-foreground/30"
                  )}
                >
                  {b}
                </button>
              ))}
            </div>
          </div>

          {/* Property types */}
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">Property type</p>
            <div className="space-y-1.5">
              {PROP_TYPES.map(t => (
                <label key={t} className="flex items-center gap-2 text-xs cursor-pointer">
                  <input
                    type="checkbox"
                    checked={filters.propertyTypes.includes(t)}
                    onChange={() => togglePropType(t)}
                    className="rounded"
                  />
                  {t.replace("_", " ")}
                </label>
              ))}
            </div>
          </div>

          {/* Cities */}
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">City</p>
            <div className="flex gap-1.5">
              <Input
                placeholder="Add city"
                value={cityInput}
                onChange={e => setCityInput(e.target.value)}
                onKeyDown={e => e.key === "Enter" && addCity()}
                className="h-8 text-xs flex-1"
              />
              <Button size="sm" variant="outline" className="h-8 px-2" onClick={addCity}>+</Button>
            </div>
            <div className="flex flex-wrap gap-1">
              {filters.cities.map(c => (
                <span key={c} className="flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs">
                  {c}
                  <button onClick={() => setFilters(f => ({ ...f, cities: f.cities.filter(x => x !== c) }))} className="text-muted-foreground hover:text-foreground">×</button>
                </span>
              ))}
            </div>
          </div>

          {/* ZIP codes */}
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">ZIP code</p>
            <div className="flex gap-1.5">
              <Input
                placeholder="Add ZIP"
                value={zipInput}
                onChange={e => setZipInput(e.target.value)}
                onKeyDown={e => e.key === "Enter" && addZip()}
                className="h-8 text-xs flex-1"
              />
              <Button size="sm" variant="outline" className="h-8 px-2" onClick={addZip}>+</Button>
            </div>
            <div className="flex flex-wrap gap-1">
              {filters.zips.map(z => (
                <span key={z} className="flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs">
                  {z}
                  <button onClick={() => setFilters(f => ({ ...f, zips: f.zips.filter(x => x !== z) }))} className="text-muted-foreground hover:text-foreground">×</button>
                </span>
              ))}
            </div>
          </div>

          <div className="pt-2 space-y-2">
            <Button className="w-full h-8 text-xs" onClick={() => runSearch()}>Search</Button>
            <Button variant="outline" className="w-full h-8 text-xs" disabled={savingCriteria} onClick={handleSaveCriteria}>
              {savingCriteria ? "Saving..." : "Save as search criteria"}
            </Button>
          </div>
        </aside>

        {/* Results area */}
        <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
          {/* NLP bar */}
          <div className="border-b border-border px-5 py-3 flex gap-2">
            <Input
              placeholder="Describe what you're looking for..."
              value={nlpQuery}
              onChange={e => setNlpQuery(e.target.value)}
              onKeyDown={e => e.key === "Enter" && runSmartSearch()}
              className="flex-1"
            />
            <Button onClick={runSmartSearch} disabled={interpreting || !nlpQuery.trim()}>
              {interpreting ? "Interpreting..." : "Search"}
            </Button>
          </div>

          {/* Saved / Results tabs */}
          <div className="flex border-b border-border px-5">
            {["Results", "Saved"].map(t => (
              <button
                key={t}
                onClick={() => setSavedTab(t === "Saved")}
                className={cn(
                  "px-4 py-2.5 text-sm font-medium border-b-2 transition-colors",
                  (t === "Saved") === savedTab
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                )}
              >
                {t}
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto px-5 py-4">
            {loading || interpreting ? (
              <div className="grid grid-cols-2 gap-4">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="rounded-lg border border-border bg-card animate-pulse">
                    <div className="aspect-[16/9] bg-muted" />
                    <div className="p-3 space-y-2">
                      <div className="h-4 w-1/2 rounded bg-muted" />
                      <div className="h-3 w-3/4 rounded bg-muted" />
                      <div className="h-7 w-full rounded bg-muted" />
                    </div>
                  </div>
                ))}
              </div>
            ) : !savedTab ? (
              properties.length === 0 && searched ? (
                <div className="flex flex-col items-center justify-center h-48 text-center space-y-2">
                  <p className="text-sm text-muted-foreground">No properties match these criteria</p>
                  <p className="text-xs text-muted-foreground">Try expanding price range or nearby ZIP codes</p>
                </div>
              ) : properties.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-48 text-center">
                  <p className="text-sm text-muted-foreground">Enter search criteria or describe what you&apos;re looking for</p>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-4">
                  {properties.map((p, i) => (
                    <PropertyCard
                      key={p.mls_number ?? p.id ?? i}
                      property={p}
                      buyerId={buyerId}
                      brokerageId={brokerageId}
                      agentUserId={agentUserId}
                      buyerPersona={buyerPersona}
                      saved={savedIds.has(p.mls_number ?? p.id ?? p.address ?? "")}
                onSave={handleSaveProperty}
                onDismiss={handleDismissProperty}
                onSchedule={handleScheduleShowing}
              />
                  ))}
                </div>
              )
            ) : (
              <SavedPropertiesTab
                buyerId={buyerId}
                brokerageId={brokerageId}
                agentUserId={agentUserId}
                buyerPersona={buyerPersona}
  onShowingGated={(p: any) => handleScheduleShowing(p)}
  />
  )}
  </div>
        </div>
      </div>
    </>
  )
}

// ─── SAVED PROPERTIES TAB ─────────────────────────────────────────────────────

  function SavedPropertiesTab({
  buyerId, brokerageId, agentUserId, buyerPersona, onShowingGated,
  }: {
  buyerId: string; brokerageId: string; agentUserId: string; buyerPersona: string | null; onShowingGated: (p: any) => void
  }) {
  const [saved, setSaved]     = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const { toast }             = useToast()
  const router                = useRouter()

  useEffect(() => {
    const supabase = createClient()
    supabase
      .from("saved_properties")
      .select("id, listing_id, property_address, mls_number, list_price, bedrooms, bathrooms, sqft, city, state, primary_photo_url, saved_at")
      .eq("contact_id", buyerId)
      .eq("dismissed", false)
      .order("saved_at", { ascending: false })
      .then(({ data }: { data: any[] | null }) => { setSaved(data ?? []); setLoading(false) })
  }, [buyerId])

  async function handleRemove(id: string) {
    const supabase = createClient()
    await supabase.from("saved_properties").update({ dismissed: true }).eq("id", id)
    setSaved(prev => prev.filter(s => s.id !== id))
    toast({ title: "Removed from saved" })
  }

  if (loading) return <div className="text-xs text-muted-foreground p-4">Loading saved properties...</div>
  if (saved.length === 0) return <div className="text-xs text-muted-foreground p-4">No saved properties yet</div>

  return (
    <div className="grid grid-cols-2 gap-4">
      {saved.map(s => {
        const isBrokerageListing = !!s.listing_id
        const displayAddress = s.property_address ?? (isBrokerageListing ? "Brokerage Listing" : "MLS Property")
        const price = s.list_price ? `$${Number(s.list_price).toLocaleString()}` : null

        return (
          <div key={s.id} className="rounded-lg border border-border bg-card overflow-hidden flex flex-col">
            {/* Photo thumbnail */}
            <div className="aspect-[16/9] bg-muted relative overflow-hidden">
              {s.primary_photo_url ? (
                <img src={s.primary_photo_url} alt={displayAddress} className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  <svg viewBox="0 0 48 48" className="w-8 h-8 text-muted-foreground/30" fill="none">
                    <path d="M6 42V20L24 6l18 14v22H30V28H18v14z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"/>
                  </svg>
                </div>
              )}
              {/* Source badge — top left of photo */}
              <div className="absolute top-2 left-2">
                {isBrokerageListing ? (
                  <Badge className="bg-purple-100 text-purple-800 border-purple-200 text-[10px] font-medium">Our Listing</Badge>
                ) : (
                  <Badge className="bg-muted text-muted-foreground border-border text-[10px] font-medium">MLS / IDX</Badge>
                )}
              </div>
            </div>

            <div className="p-3 flex flex-col gap-2 flex-1">
              {price && <p className="text-sm font-semibold">{price}</p>}
              <p className="text-xs text-muted-foreground leading-tight">
                {displayAddress}{s.city ? `, ${s.city}` : ""}{s.state ? `, ${s.state}` : ""}
              </p>
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                {s.bedrooms  != null && <span>{s.bedrooms} bd</span>}
                {s.bathrooms != null && <span>{s.bathrooms} ba</span>}
                {s.sqft      != null && <span>{Number(s.sqft).toLocaleString()} sqft</span>}
              </div>

              {/* Brokerage listing extras */}
              {isBrokerageListing && (
                <Link
                  href={`/dashboard/listings/${s.listing_id}`}
                  className="text-xs text-purple-700 hover:underline"
                >
                  View Listing Details
                </Link>
              )}

              {/* Actions */}
              <div className="flex flex-wrap gap-2 pt-1 mt-auto">
                <Button
                  size="sm"
                  className="flex-1 h-7 text-xs"
                  onClick={() => {
                    if (isBrokerageListing) {
                      router.push(`/dashboard/buyers/${buyerId}/offers/new?listingId=${s.listing_id}`)
                    } else {
                      router.push(`/dashboard/buyers/${buyerId}/offers/new?address=${encodeURIComponent(s.property_address ?? "")}`)
                    }
                  }}
                >
                  Make Offer
                </Button>
                <Button size="sm" variant="outline" className="flex-1 h-7 text-xs" onClick={() => onShowingGated({ id: s.id, mls_number: s.mls_number ?? undefined, address: s.property_address ?? undefined, city: s.city ?? undefined, state: s.state ?? undefined, list_price: s.list_price ?? undefined, bedrooms: s.bedrooms ?? undefined, bathrooms: s.bathrooms ?? undefined, sqft: s.sqft ?? undefined, primary_photo_url: s.primary_photo_url ?? undefined })}>Schedule</Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs text-destructive border-destructive/20 hover:bg-destructive/5"
                  onClick={() => handleRemove(s.id)}
                >
                  Remove
                </Button>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
