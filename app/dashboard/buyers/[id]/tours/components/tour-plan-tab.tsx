'use client'

import { useState, useTransition } from 'react'
import { GripVertical, X, Clock, MapPin, Phone, ChevronDown, Route, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import { toast } from '@/hooks/use-toast'
import {
  createTourPlan,
  generateTourNarrative,
  updateTourStopOrder,
  type TourStop,
} from '@/app/actions/tour-planner'
import { optimizeTourRoute } from '@/app/actions/ai-showing-management'

// saved_properties stores address data directly on the row — no listings FK.
interface SavedProperty {
  id: string
  listing_id: string | null
  notes: string | null
  ai_match_score: number | null
  added_to_tour: boolean
  property_address: string | null
  mls_number: string | null
  list_price: number | null
  bedrooms: number | null
  bathrooms: number | null
  sqft: number | null
  city: string | null
  state: string | null
  primary_photo_url: string | null
  // Legacy join field — always null now, kept for type compat during transition
  listings?: null
}

interface TourPlanTabProps {
  contactId: string
  agentUserId: string
  brokerageId: string
  buyerName: string
  savedProperties: SavedProperty[]
  onTourCreated: () => void
  disabled?: boolean
}

const DURATION_OPTIONS = [
  { value: '15', label: '15 min' },
  { value: '30', label: '30 min' },
  { value: '45', label: '45 min' },
  { value: '60', label: '60 min' },
]

function formatPrice(price: number | null): string {
  if (!price) return 'Price N/A'
  return '$' + price.toLocaleString()
}

export function TourPlanTab({
  contactId, agentUserId, brokerageId, buyerName, savedProperties, onTourCreated,
  disabled = false,
}: TourPlanTabProps) {
  const [selectedIds, setSelectedIds]   = useState<Set<string>>(new Set())
  const [orderedStops, setOrderedStops] = useState<TourStop[]>([])
  const [durations, setDurations]       = useState<Record<string, number>>({})
  const [tourDate, setTourDate]         = useState('')
  const [startTime, setStartTime]       = useState('10:00')
  const [manualAddress, setManualAddress] = useState('')
  const [narrative, setNarrative]             = useState<string | null>(null)
  const [narrativeLoading, setNarrativeLoading] = useState(false)
  const [isPending, startTransition]          = useTransition()
  const [optimizingRoute, setOptimizingRoute] = useState(false)
  const [routeSummary, setRouteSummary]       = useState<string | null>(null)

  // Stored tourId + stop IDs after creation so drag reorder can persist order
  const [createdTourId, setCreatedTourId]     = useState<string | null>(null)
  const [createdStopIds, setCreatedStopIds]   = useState<string[]>([])
  const [dragIdx, setDragIdx]                 = useState<number | null>(null)

  function toggleProperty(prop: SavedProperty) {
    const key = prop.listing_id ?? prop.id
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(key)) {
        next.delete(key)
        // Remove by matching either listingId or the MLS property address directly on the row
        setOrderedStops(os => os.filter(s =>
          !(s.listingId && s.listingId === prop.listing_id) &&
          !(s.propertyAddress === prop.property_address)
        ))
      } else {
        if (orderedStops.length >= 10) {
          toast({ title: 'Maximum 10 stops per tour', variant: 'destructive' })
          return prev
        }
        next.add(key)
        const stop: TourStop = {
          listingId:              prop.listing_id ?? undefined,
          propertyAddress:        prop.property_address ?? '',
          city:                   prop.city ?? undefined,
          state:                  prop.state ?? undefined,
          listPrice:              prop.list_price ?? undefined,
          mlsNumber:              prop.mls_number ?? undefined,
          primaryPhotoUrl:        prop.primary_photo_url ?? undefined,
          suggestedDurationMinutes: 30,
        }
        setOrderedStops(os => [...os, stop])
        setDurations(d => ({ ...d, [key]: 30 }))
      }
      return next
    })
  }

  function addManualAddress() {
    if (!manualAddress.trim()) return
    const stop: TourStop = { propertyAddress: manualAddress.trim(), suggestedDurationMinutes: 30 }
    setOrderedStops(os => [...os, stop])
    setManualAddress('')
  }

  function removeStop(idx: number) {
    const stop = orderedStops[idx]
    const key  = stop.listingId ?? stop.propertyAddress
    setSelectedIds(prev => { const n = new Set(prev); n.delete(key); return n })
    setOrderedStops(os => os.filter((_, i) => i !== idx))
  }

  function setDuration(idx: number, mins: number) {
    setOrderedStops(os => os.map((s, i) => i === idx ? { ...s, suggestedDurationMinutes: mins } : s))
  }

  async function handleOptimizeRoute() {
    if (orderedStops.length < 2) return
    setOptimizingRoute(true)
    try {
      if (createdTourId) {
        const res = await optimizeTourRoute(createdTourId)
        if (res.success) {
          setRouteSummary((res as any).summary ?? 'Route optimized — stops reordered for minimum drive time.')
          toast({ title: 'Route optimized' })
        } else {
          toast({ title: (res as any).error ?? 'Route optimization failed', variant: 'destructive' })
        }
      } else {
        // No saved tour yet — use AI to reorder stops by proximity heuristic
        const addressList = orderedStops.map((s, i) => `${i + 1}. ${s.propertyAddress}${s.city ? ', ' + s.city : ''}`).join('\n')
        const { generateText } = await import('ai')
        const { text } = await generateText({
          model: 'openai/gpt-4o-mini',
          prompt: `Suggest the most efficient driving order for these properties (return comma-separated numbers only):\n${addressList}`,
        })
        const order = text.match(/\d+/g)?.map(Number).filter(n => n >= 1 && n <= orderedStops.length)
        if (order && order.length === orderedStops.length) {
          const reordered = order.map(n => orderedStops[n - 1])
          setOrderedStops(reordered)
          setRouteSummary('Stops reordered by AI for efficient routing.')
          toast({ title: 'Route optimized' })
        } else {
          toast({ title: 'Could not parse optimized order', variant: 'destructive' })
        }
      }
    } catch {
      toast({ title: 'Route optimization failed', variant: 'destructive' })
    } finally {
      setOptimizingRoute(false)
    }
  }

  async function handleGenerateNarrative() {
    if (!orderedStops.length) return
    setNarrativeLoading(true)
    const res = await generateTourNarrative({ contactId, brokerageId, stops: orderedStops, buyerName })
    setNarrative(res.narrative)
    setNarrativeLoading(false)
  }

  function handleCreate() {
    if (!tourDate || !orderedStops.length) {
      toast({ title: 'Select a date and at least one property', variant: 'destructive' })
      return
    }
    startTransition(async () => {
      const res = await createTourPlan({
        contactId, agentUserId, brokerageId,
        tourDate, startTime,
        stops: orderedStops,
        aiPlanNarrative: narrative ?? undefined,
      })
      if (res.success) {
        if (res.tourId) setCreatedTourId(res.tourId)
        if (res.stopIds) setCreatedStopIds(res.stopIds)
        toast({ title: `Tour plan created — ${res.stopCount} stops` })
        onTourCreated()
      } else {
        toast({ title: res.error ?? 'Failed to create tour', variant: 'destructive' })
      }
    })
  }

  // Compute suggested times for preview
  function computePreviewTimes(): string[] {
    const times: string[] = []
    let [h, m] = startTime.split(':').map(Number)
    orderedStops.forEach((stop, i) => {
      times.push(`${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`)
      const dur = stop.suggestedDurationMinutes ?? 30
      const total = h * 60 + m + dur
      h = Math.floor(total / 60) % 24
      m = total % 60
    })
    return times
  }

  const totalMins = orderedStops.reduce((a, s) => a + (s.suggestedDurationMinutes ?? 30), 0)
  const totalHrs  = (totalMins / 60).toFixed(1)
  const previewTimes = computePreviewTimes()

  return (
    <div className="relative flex gap-6 h-full min-h-0">
      {/* Gate overlay — blocks all interaction when tour scheduling is locked */}
      {disabled && (
        <div className="absolute inset-0 z-10 rounded-lg bg-background/80 backdrop-blur-sm flex items-center justify-center">
          <p className="text-sm font-medium text-muted-foreground">Tour creation is locked — complete financial verification to unlock.</p>
        </div>
      )}
      {/* Left panel */}
      <div className="w-72 flex-shrink-0 flex flex-col gap-4">
        <div>
          <p className="text-sm font-medium text-foreground mb-2">
            Available Properties
          </p>
          <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
            {savedProperties.length === 0 && (
              <p className="text-xs text-muted-foreground">No saved properties yet.</p>
            )}
            {savedProperties.map(prop => {
              const key = prop.listing_id ?? prop.id
              return (
                <label key={prop.id} className="flex items-start gap-2 cursor-pointer p-2 rounded-md hover:bg-accent">
                  <Checkbox
                    checked={selectedIds.has(key)}
                    onCheckedChange={() => toggleProperty(prop)}
                    className="mt-0.5"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <p className="text-xs font-medium leading-tight truncate flex-1">
                        {prop.property_address ?? 'Unknown address'}
                      </p>
                      {prop.ai_match_score != null && (
                        <Badge variant="secondary" className="text-[10px] px-1.5 py-0 shrink-0">
                          {prop.ai_match_score}%
                        </Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {formatPrice(prop.list_price ?? null)}
                      {prop.bedrooms ? ` · ${prop.bedrooms}bd` : ''}
                      {prop.bathrooms ? `/${prop.bathrooms}ba` : ''}
                    </p>
                  </div>
                </label>
              )
            })}
          </div>
        </div>

        {/* Manual address add */}
        <div className="flex gap-1">
          <Input
            placeholder="Add by address"
            value={manualAddress}
            onChange={e => setManualAddress(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && addManualAddress()}
            className="text-xs h-8"
          />
          <Button size="sm" variant="outline" onClick={addManualAddress} className="h-8 px-2 text-xs">
            Add
          </Button>
        </div>

        {/* Selected stops with drag handles */}
        {orderedStops.length > 0 && (
          <div className="border rounded-md p-2 space-y-1">
            <p className="text-xs font-medium text-muted-foreground mb-1">
              Tour Stops ({orderedStops.length})
            </p>
            {orderedStops.map((stop, idx) => (
              <div
                key={idx}
                className="flex items-center gap-1 group"
                draggable
                onDragStart={() => setDragIdx(idx)}
                onDragOver={(e) => { e.preventDefault() }}
                onDrop={() => {
                  if (dragIdx === null || dragIdx === idx) { setDragIdx(null); return }
                  const next = [...orderedStops]
                  const [moved] = next.splice(dragIdx, 1)
                  next.splice(idx, 0, moved)
                  setOrderedStops(next)
                  // Reorder createdStopIds in the same way so they stay in sync
                  if (createdStopIds.length > 0) {
                    const nextIds = [...createdStopIds]
                    const [movedId] = nextIds.splice(dragIdx, 1)
                    nextIds.splice(idx, 0, movedId)
                    setCreatedStopIds(nextIds)
                    if (createdTourId) {
                      void updateTourStopOrder(createdTourId, nextIds)
                    }
                  }
                  setDragIdx(null)
                }}
                onDragEnd={() => setDragIdx(null)}
              >
                <GripVertical className="h-3 w-3 text-muted-foreground cursor-grab" />
                <span className="flex-1 text-xs truncate">{stop.propertyAddress}</span>
                <Select
                  value={String(stop.suggestedDurationMinutes ?? 30)}
                  onValueChange={v => setDuration(idx, Number(v))}
                >
                  <SelectTrigger className="h-6 w-16 text-xs px-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DURATION_OPTIONS.map(o => (
                      <SelectItem key={o.value} value={o.value} className="text-xs">{o.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <button onClick={() => removeStop(idx)} className="text-muted-foreground hover:text-destructive">
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Date + time pickers */}
        <div className="space-y-2">
          <div>
            <Label className="text-xs">Tour date</Label>
            <Input type="date" value={tourDate} onChange={e => setTourDate(e.target.value)} className="h-8 text-xs mt-1" />
          </div>
          <div>
            <Label className="text-xs">Start time</Label>
            <Input type="time" value={startTime} onChange={e => setStartTime(e.target.value)} className="h-8 text-xs mt-1" />
          </div>
        </div>
      </div>

      {/* Right panel — preview */}
      <div className="flex-1 flex flex-col gap-4 min-w-0">
        {orderedStops.length === 0 ? (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-sm text-muted-foreground">Select properties on the left to build your tour plan.</p>
          </div>
        ) : (
          <>
            {/* Header */}
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div>
                <span className="text-sm font-semibold">SHOWING PLAN</span>
                {tourDate && <span className="text-sm text-muted-foreground ml-2">{tourDate}</span>}
                <span className="text-xs text-muted-foreground ml-2">
                  {orderedStops.length} stops · ~{totalHrs}hr total
                </span>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="text-xs gap-1.5"
                onClick={handleOptimizeRoute}
                disabled={optimizingRoute || orderedStops.length < 2}
                title={orderedStops.length < 2 ? 'Add at least 2 stops to optimize' : undefined}
              >
                {optimizingRoute ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Route className="h-3.5 w-3.5" />
                )}
                Optimize Route
              </Button>
            </div>

            {/* Route optimization result */}
            {routeSummary && (
              <div className="px-3 py-2 bg-blue-50 border border-blue-100 rounded-md text-xs text-blue-800">
                {routeSummary}
              </div>
            )}

            {/* Stop cards */}
            <div className="space-y-3 flex-1 overflow-y-auto pr-1">
              {orderedStops.map((stop, idx) => (
                <Card key={idx} className="border">
                  <CardContent className="pt-3 pb-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-xs font-semibold text-muted-foreground">
                          STOP {idx + 1} — {previewTimes[idx]} ({stop.suggestedDurationMinutes ?? 30} min)
                        </p>
                        <p className="text-sm font-medium leading-tight">{stop.propertyAddress}</p>
                        {(stop.city || stop.state) && (
                          <p className="text-xs text-muted-foreground">{[stop.city, stop.state, stop.zip].filter(Boolean).join(', ')}</p>
                        )}
                        {stop.listPrice && (
                          <p className="text-xs text-muted-foreground">{formatPrice(stop.listPrice)}</p>
                        )}
                        {stop.listingAgentName && (
                          <div className="flex items-center gap-1 mt-1">
                            <Phone className="h-3 w-3 text-muted-foreground" />
                            <span className="text-xs">{stop.listingAgentName}</span>
                            {stop.listingAgentPhone && <span className="text-xs text-muted-foreground">{stop.listingAgentPhone}</span>}
                          </div>
                        )}
                        <p className="text-xs text-muted-foreground mt-1">
                          {stop.schedulingMethod === 'showingtime'
                            ? 'Schedule via ShowingTime'
                            : 'Call listing agent to request showing time'}
                        </p>
                        <p className="text-xs text-muted-foreground italic">Access: TBD — fill in after confirming time</p>
                      </div>
                      <Badge variant="outline" className="text-xs shrink-0">
                        {formatPrice(stop.listPrice ?? null)}
                      </Badge>
                    </div>
                    {idx < orderedStops.length - 1 && stop.driveTimeFromPrevMinutes && (
                      <p className="text-xs text-muted-foreground mt-2">
                        ~{stop.driveTimeFromPrevMinutes} min drive to next stop
                      </p>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>

            {/* AI narrative */}
            <div className="border rounded-md p-3 bg-muted/40">
              <div className="flex items-center justify-between mb-1">
                <p className="text-xs font-medium">AI Tour Narrative</p>
                <Button variant="ghost" size="sm" className="h-6 text-xs px-2" onClick={handleGenerateNarrative} disabled={narrativeLoading}>
                  {narrativeLoading ? 'Generating...' : narrative ? 'Regenerate' : 'Generate'}
                </Button>
              </div>
              {narrativeLoading && <Skeleton className="h-10 w-full" />}
              {!narrativeLoading && narrative && (
                <p className="text-xs text-muted-foreground leading-relaxed">{narrative}</p>
              )}
              {!narrativeLoading && !narrative && (
                <p className="text-xs text-muted-foreground italic">Click Generate for an AI-written tour summary.</p>
              )}
            </div>

            {/* Send plan button */}
            <Button
              onClick={handleCreate}
              disabled={disabled || isPending || !tourDate || orderedStops.length === 0}
              className="w-full"
            >
              {isPending ? 'Creating tour plan...' : 'Continue to Confirm \u2192'}
            </Button>
          </>
        )}
      </div>
    </div>
  )
}
