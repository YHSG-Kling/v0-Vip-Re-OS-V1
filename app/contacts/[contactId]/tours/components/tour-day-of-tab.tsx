'use client'

import { useState, useTransition, useEffect, useRef } from 'react'
import { ChevronLeft, ChevronRight, Phone, MapPin, Key, Route, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { toast } from '@/hooks/use-toast'
import { rateTourStop, completeTour } from '@/app/actions/tour-planner'
import { aiOptimizeShowingRoute } from '@/app/actions/ai-showing-management'

interface TourStop {
  id: string
  tour_id: string
  order_index: number
  property_address: string
  city: string | null
  state: string | null
  zip: string | null
  list_price: number | null
  listing_id: string | null
  primary_photo_url: string | null
  listing_agent_name: string | null
  listing_agent_phone: string | null
  listing_agent_company: string | null
  access_method: string | null
  access_code: string | null
  access_instructions: string | null
  confirmed_time: string | null
  buyer_interest_level: string | null
  buyer_note: string | null
  showing_id: string | null
}

interface Tour {
  id: string
  tour_date: string
  status: string
  tour_stops: TourStop[]
}

interface TourDayOfTabProps {
  tours: Tour[]
  contactId: string
  brokerageId: string
  agentUserId: string
  buyerName: string
  buyerPhone?: string
  onRefresh: () => void
}

type InterestLevel = 'love_it' | 'like_it' | 'maybe' | 'no'

const INTEREST_LABELS: Record<InterestLevel, { label: string; color: string }> = {
  love_it: { label: 'Love It',     color: 'bg-rose-100 text-rose-700 border-rose-200 hover:bg-rose-200' },
  like_it: { label: 'Like It',     color: 'bg-green-100 text-green-700 border-green-200 hover:bg-green-200' },
  maybe:   { label: 'Maybe',       color: 'bg-yellow-100 text-yellow-700 border-yellow-200 hover:bg-yellow-200' },
  no:      { label: 'Not For Us',  color: 'bg-slate-100 text-slate-600 border-slate-200 hover:bg-slate-200' },
}

function formatTime(ts: string | null): string {
  if (!ts) return 'TBD'
  return new Date(ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

function formatPrice(p: number | null): string {
  if (!p) return ''
  return '$' + p.toLocaleString()
}

export function TourDayOfTab({ tours, contactId, brokerageId, agentUserId, buyerName, buyerPhone, onRefresh }: TourDayOfTabProps) {
  const today = new Date().toISOString().slice(0, 10)
  const todayTour = tours.find(t => t.tour_date === today && ['planned','confirmed','active'].includes(t.status))
  const upcomingTour = todayTour ?? tours.find(t => ['planned','confirmed'].includes(t.status))

  const [isOffline, setIsOffline]           = useState(false)
  const [currentIdx, setCurrentIdx]         = useState(0)
  const [ratings, setRatings]               = useState<Record<string, InterestLevel>>({})
  const [pendingSignals, setPendingSignals] = useState<Array<{ stopId: string; level: InterestLevel }>>([])
  const [notes, setNotes]                   = useState<Record<string, string>>({})
  // Mobile route optimization
  const [isOptimizingRoute, setIsOptimizingRoute] = useState(false)
  const [routeOptimized, setRouteOptimized]       = useState(false)
  const [showRating, setShowRating]         = useState(false)
  const [tourComplete, setTourComplete]     = useState(false)
  const [agentNote, setAgentNote]           = useState('')
  const [isPending, startTransition]        = useTransition()

  // Stopwatch per stop
  const [elapsed, setElapsed]   = useState(0)          // seconds
  const timerRef                = useRef<ReturnType<typeof setInterval> | null>(null)

  // navigator.onLine tracking — flush queued signals on reconnect
  useEffect(() => {
    function handleOnline() {
      setIsOffline(false)
      const toFlush = [...pendingSignalsRef.current]
      if (!toFlush.length) return
      setPendingSignals([])
      for (const sig of toFlush) {
        rateTourStop({
          tourStopId:      sig.stopId,
          showingId:       '',
          contactId,       brokerageId,    agentUserId,
          interestLevel:   sig.level,
          propertyAddress: '',
          note:            notesRef.current[sig.stopId],
        }).catch(() => {})
      }
    }
    function handleOffline() { setIsOffline(true) }
    setIsOffline(!navigator.onLine)
    window.addEventListener('online',  handleOnline)
    window.addEventListener('offline', handleOffline)
    return () => {
      window.removeEventListener('online',  handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Refs so the online handler can access latest state without stale closure
  const pendingSignalsRef = useRef(pendingSignals)
  const notesRef          = useRef(notes)
  useEffect(() => { pendingSignalsRef.current = pendingSignals }, [pendingSignals])
  useEffect(() => { notesRef.current = notes }, [notes])

  // Restart stopwatch when stop changes
  useEffect(() => {
    setElapsed(0)
    if (timerRef.current) clearInterval(timerRef.current)
    timerRef.current = setInterval(() => setElapsed(s => s + 1), 1000)
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [currentIdx])

  function formatElapsed(secs: number): string {
    const m = Math.floor(secs / 60).toString().padStart(2, '0')
    const s = (secs % 60).toString().padStart(2, '0')
    return `${m}:${s}`
  }

  const activeTour = upcomingTour
  const sortedStops = activeTour
    ? [...activeTour.tour_stops].sort((a, b) => a.order_index - b.order_index)
    : []
  const stop = sortedStops[currentIdx]
  const nextStop = sortedStops[currentIdx + 1] ?? null

  function handleRating(level: InterestLevel) {
    if (!stop) return
    setRatings(r => ({ ...r, [stop.id]: level }))
  }

  function handleSaveAndContinue() {
    if (!stop) return
    const level = ratings[stop.id]
    if (!level) { toast({ title: 'Select a rating before continuing', variant: 'destructive' }); return }

    startTransition(async () => {
      const saveStop = async () => {
        return await rateTourStop({
          tourStopId:      stop.id,
          showingId:       stop.showing_id ?? '',
          contactId,
          brokerageId,
          agentUserId,
          listingId:       stop.listing_id ?? undefined,
          propertyAddress: stop.property_address,
          listPrice:       stop.list_price ?? undefined,
          city:            stop.city ?? undefined,
          zip:             stop.zip ?? undefined,
          interestLevel:   level,
          note:            notes[stop.id],
        })
      }

      if (!isOffline) {
        await saveStop()
      } else {
        // Queue signal to flush when online
        setPendingSignals(q => [...q, { stopId: stop.id, level }])
      }

      setShowRating(false)
      if (currentIdx < sortedStops.length - 1) {
        setCurrentIdx(i => i + 1)
      } else {
        setTourComplete(true)
      }
    })
  }

  function handleFinishTour() {
    startTransition(async () => {
      const stopRatings = sortedStops.map(s => ({
        tourStopId:      s.id,
        showingId:       s.showing_id ?? '',
        interestLevel:   (ratings[s.id] ?? 'maybe') as InterestLevel,
        note:            notes[s.id],
        listingId:       s.listing_id ?? undefined,
        propertyAddress: s.property_address,
        listPrice:       s.list_price ?? undefined,
        city:            s.city ?? undefined,
      }))
      const res = await completeTour({
        tourId:       activeTour!.id,
        contactId,
        brokerageId,
        agentUserId,
        agentNote,
        stopRatings,
      })
      if (res.success) {
        toast({ title: `Tour complete! ${res.lovedCount} loved, ${res.likedCount} liked` })
        onRefresh()
      } else {
        toast({ title: 'Failed to complete tour', variant: 'destructive' })
      }
    })
  }

  async function handleOptimizeRoute() {
    if (!activeTour) return
    setIsOptimizingRoute(true)
    try {
      const showingIds = sortedStops
        .filter(s => s.showing_id)
        .map(s => s.showing_id!)
      const res = await aiOptimizeShowingRoute({
        agentId:    agentUserId,
        date:       activeTour.tour_date,
        showingIds: showingIds.length > 0 ? showingIds : undefined,
      })
      if (res.success) {
        setRouteOptimized(true)
        toast({ title: 'Route optimized for today' })
        onRefresh()
      } else {
        toast({ title: res.error ?? 'Route optimization failed', variant: 'destructive' })
      }
    } catch (err) {
      toast({ title: 'Route optimization failed', variant: 'destructive' })
    } finally {
      setIsOptimizingRoute(false)
    }
  }

  if (!activeTour || sortedStops.length === 0) {
    return (
      <div className="flex items-center justify-center h-48">
        <p className="text-sm text-muted-foreground">No active tour found. Create and confirm a tour first.</p>
      </div>
    )
  }

  const lovedCount   = Object.values(ratings).filter(r => r === 'love_it').length
  const likedCount   = Object.values(ratings).filter(r => r === 'like_it').length
  const maybeCount   = Object.values(ratings).filter(r => r === 'maybe').length
  const noCount      = Object.values(ratings).filter(r => r === 'no').length

  // ── Tour complete screen ────────────────────────────────────────────────────
  if (tourComplete) {
    const lovedStops = sortedStops.filter(s => ratings[s.id] === 'love_it')
    return (
      <div className="space-y-6 max-w-lg mx-auto">
        <div className="text-center">
          <p className="text-2xl font-bold">Tour Complete</p>
          <p className="text-muted-foreground mt-1">
            {sortedStops.length} stops · {lovedCount} loved · {likedCount} liked · {maybeCount} maybe · {noCount} no
          </p>
        </div>

        {lovedStops.length > 0 && (
          <div>
            <p className="text-sm font-semibold mb-2">Properties they loved:</p>
            <div className="space-y-2">
              {lovedStops.map(s => (
                <div key={s.id} className="flex items-center gap-3 p-2 rounded-md border bg-rose-50/40">
                  {s.primary_photo_url && (
                    <img src={s.primary_photo_url} alt="" className="w-12 h-12 object-cover rounded-md" />
                  )}
                  <div>
                    <p className="text-sm font-medium">{s.property_address}</p>
                    {s.city && <p className="text-xs text-muted-foreground">{s.city}, {s.state}</p>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {lovedStops.length > 0 && (
          <div className="p-3 bg-amber-50 border border-amber-200 rounded-md flex items-start justify-between gap-3">
            <p className="text-sm font-medium text-amber-900">
              {buyerName} loved {lovedStops[0].property_address}. Ready to discuss an offer?
            </p>
            <a
              href={`/contacts/${contactId}/offers/new`}
              className="shrink-0 px-3 py-1.5 bg-amber-700 text-white text-xs font-semibold rounded-md hover:bg-amber-800 transition-colors whitespace-nowrap"
            >
              Start Offer
            </a>
          </div>
        )}

        <div>
          <label className="text-xs font-medium">Agent note (optional)</label>
          <Input
            value={agentNote}
            onChange={e => setAgentNote(e.target.value)}
            placeholder="Overall tour observations..."
            className="mt-1 text-sm"
          />
        </div>

        <Button onClick={handleFinishTour} disabled={isPending} className="w-full">
          {isPending ? 'Finishing...' : 'Finish Tour'}
        </Button>
      </div>
    )
  }

  // ── Main day-of navigator ───────────────────────────────────────────────────
  return (
    <div className="space-y-4 max-w-lg mx-auto">
      {/* Online/offline status — driven by navigator.onLine */}
      {isOffline && (
        <div className="flex items-center gap-2 p-2.5 rounded-lg border border-amber-300 bg-amber-50 text-amber-800">
          <span className="w-2 h-2 rounded-full bg-amber-500 shrink-0" />
          <p className="text-xs font-medium">
            Offline — feedback queued ({pendingSignals.length} pending). Will sync when connection restores.
          </p>
        </div>
      )}

      {/* Mobile route optimization */}
      {sortedStops.length > 1 && (
        <div className="flex items-center justify-between p-2.5 rounded-lg border bg-muted/40">
          <p className="text-xs text-muted-foreground">
            {routeOptimized ? 'Route optimized for today' : `${sortedStops.length} stops — optimize for drive time?`}
          </p>
          <Button
            size="sm"
            variant={routeOptimized ? "secondary" : "outline"}
            className="text-xs h-7 gap-1.5 shrink-0 ml-2"
            onClick={handleOptimizeRoute}
            disabled={isOptimizingRoute || routeOptimized}
          >
            {isOptimizingRoute ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Route className="h-3.5 w-3.5" />
            )}
            {routeOptimized ? 'Optimized' : 'Optimize Route'}
          </Button>
        </div>
      )}

      {/* Stop navigator */}
      <div className="flex items-center justify-between">
        <Button variant="outline" size="icon" onClick={() => { setCurrentIdx(i => Math.max(0, i-1)); setShowRating(false) }} disabled={currentIdx === 0}>
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <p className="text-sm font-semibold">SHOWING {currentIdx + 1} of {sortedStops.length}</p>
        <Button variant="outline" size="icon" onClick={() => { setShowRating(true) }} disabled={showRating}>
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>

      {/* Current stop card */}
      {!showRating && stop && (
        <Card className="overflow-hidden">
          {/* Time header with stopwatch */}
          <div className="flex items-center justify-between px-4 py-2 bg-muted/60 border-b">
            <span className="text-sm font-mono font-semibold">{formatTime(stop.confirmed_time)}</span>
            <div className="flex items-center gap-3">
              <span className="text-xs text-muted-foreground font-mono">
                Time at this stop: {formatElapsed(elapsed)}
              </span>
              <span className="text-xs text-muted-foreground">STOP {currentIdx + 1} of {sortedStops.length}</span>
            </div>
          </div>

          {/* Photo */}
          {stop.primary_photo_url && (
            <div className="h-48 overflow-hidden">
              <img src={stop.primary_photo_url} alt={stop.property_address} className="w-full h-full object-cover" />
            </div>
          )}

          <CardContent className="p-4 space-y-4">
            {/* Address */}
            <div>
              <div className="flex items-start gap-2">
                <MapPin className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
                <div>
                  <p className="font-semibold text-base leading-tight">{stop.property_address}</p>
                  <p className="text-sm text-muted-foreground">
                    {[stop.city, stop.state, stop.zip].filter(Boolean).join(', ')}
                  </p>
                  {stop.list_price && (
                    <p className="text-sm text-muted-foreground">{formatPrice(stop.list_price)}</p>
                  )}
                </div>
              </div>
              <a
                href={`https://maps.apple.com/?q=${encodeURIComponent(stop.property_address + ' ' + (stop.city ?? ''))}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-primary underline mt-1 block"
              >
                Open in Maps
              </a>
            </div>

            <div className="h-px bg-border" />

            {/* Buyer */}
            <div>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">Buyer</p>
              <p className="font-medium">{buyerName}</p>
              {buyerPhone && (
                <div className="flex items-center gap-2 mt-1">
                  <Phone className="h-3 w-3 text-muted-foreground" />
                  <span className="text-sm">{buyerPhone}</span>
                  <a
                    href={`tel:${buyerPhone}`}
                    className="ml-auto px-3 py-1 bg-primary text-primary-foreground text-xs rounded-md font-medium"
                  >
                    Tap to Call
                  </a>
                </div>
              )}
            </div>

            {(stop.listing_agent_name || stop.listing_agent_phone) && (
              <>
                <div className="h-px bg-border" />
                <div>
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">Listing Agent</p>
                  {stop.listing_agent_name && <p className="font-medium">{stop.listing_agent_name}</p>}
                  {stop.listing_agent_company && <p className="text-xs text-muted-foreground">{stop.listing_agent_company}</p>}
                  {stop.listing_agent_phone && (
                    <div className="flex items-center gap-2 mt-1">
                      <Phone className="h-3 w-3 text-muted-foreground" />
                      <span className="text-sm">{stop.listing_agent_phone}</span>
                      <a
                        href={`tel:${stop.listing_agent_phone}`}
                        className="ml-auto px-3 py-1 bg-secondary text-secondary-foreground text-xs rounded-md font-medium"
                      >
                        Tap to Call
                      </a>
                    </div>
                  )}
                </div>
              </>
            )}

            {(stop.access_method || stop.access_code) && (
              <>
                <div className="h-px bg-border" />
                <div>
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">Access</p>
                  <div className="flex items-center gap-2">
                    <Key className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm capitalize">{stop.access_method?.replace(/_/g, ' ')}</span>
                  </div>
                  {stop.access_code && (
                    <p className="text-4xl font-mono font-bold tracking-widest mt-1 text-foreground">
                      {stop.access_code}
                    </p>
                  )}
                  {stop.access_instructions && (
                    <p className="text-sm text-muted-foreground mt-1 leading-relaxed">{stop.access_instructions}</p>
                  )}
                </div>
              </>
            )}

            {nextStop && (
              <>
                <div className="h-px bg-border" />
                <p className="text-xs text-muted-foreground">
                  Next stop: {nextStop.property_address}
                </p>
              </>
            )}

            <Button className="w-full" onClick={() => setShowRating(true)}>
              {currentIdx < sortedStops.length - 1 ? 'Next Stop' : 'Finish Tour'}
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Post-showing rating panel */}
      {showRating && stop && (
        <Card>
          <CardContent className="pt-4 pb-4 space-y-4">
            <p className="text-sm font-semibold">
              How did {buyerName} respond to {stop.property_address}?
            </p>
            <div className="grid grid-cols-2 gap-3">
              {(Object.entries(INTEREST_LABELS) as [InterestLevel, { label: string; color: string }][]).map(([level, meta]) => (
                <button
                  key={level}
                  onClick={() => handleRating(level)}
                  className={`px-4 py-3 rounded-lg border-2 font-medium text-sm transition-colors ${meta.color} ${ratings[stop.id] === level ? 'ring-2 ring-offset-1 ring-primary' : ''}`}
                >
                  {meta.label}
                </button>
              ))}
            </div>
            <Input
              placeholder="Optional note..."
              value={notes[stop.id] ?? ''}
              onChange={e => setNotes(n => ({ ...n, [stop.id]: e.target.value }))}
              className="text-sm"
            />
            <Button
              onClick={handleSaveAndContinue}
              disabled={isPending || !ratings[stop.id]}
              className="w-full"
            >
              {isPending ? 'Saving...' : 'Save & Continue'}
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
