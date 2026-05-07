'use client'

import { useState, useTransition } from 'react'
import { ChevronDown, ChevronRight, CheckCircle, Clock, MapPin, ArrowLeft, Route, CalendarPlus, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { toast } from '@/hooks/use-toast'
import { confirmTourStop, confirmTour, scheduleTourStops, finalizeTour } from '@/app/actions/tour-planner'
import { optimizeTourRoute, aiScheduleShowing } from '@/app/actions/ai-showing-management'

interface TourStop {
  id: string
  tour_id: string
  order_index: number
  property_address: string
  city: string | null
  state: string | null
  zip: string | null
  mls_number: string | null
  listing_id: string | null
  listing_agent_name: string | null
  listing_agent_phone: string | null
  listing_agent_company: string | null
  access_method: string | null
  access_code: string | null
  access_instructions: string | null
  confirmed_time: string | null
  is_confirmed: boolean
  showing_id: string | null
  scheduling_reference: string | null
}

interface Tour {
  id: string
  tour_date: string
  status: string
  all_confirmed?: boolean
  tour_stops: TourStop[]
}

interface TourConfirmTabProps {
  tours: Tour[]
  contactId: string
  brokerageId: string
  agentUserId: string
  onRefresh: () => void
  onBackToPlan?: () => void
}

const ACCESS_METHODS = [
  { value: 'lockbox',        label: 'Lockbox' },
  { value: 'agent_present',  label: 'Agent Present' },
  { value: 'key_at_office',  label: 'Key at Office' },
  { value: 'smart_lock',     label: 'Smart Lock' },
  { value: 'tenant_access',  label: 'Tenant Access' },
  { value: 'other',          label: 'Other' },
]

function formatDate(d: string) {
  return new Date(d + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

function buildMapUrl(stops: TourStop[]): string | null {
  if (!stops.length) return null
  if (process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY) {
    const origin      = encodeURIComponent(stops[0].property_address)
    const destination = encodeURIComponent(stops[stops.length - 1].property_address)
    const waypoints   = stops.slice(1, -1).map(s => encodeURIComponent(s.property_address)).join('|')
    return `https://maps.googleapis.com/maps/api/staticmap?size=600x200&path=weight:3%7Ccolor:0x3b82f6&markers=${stops.map((s, i) => `label:${i + 1}%7C${encodeURIComponent(s.property_address)}`).join('&markers=')}&key=${process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY}`
  }
  return null
}

function StopConfirmForm({
  stop, tourId, contactId, brokerageId, agentUserId, onDone,
}: {
  stop: TourStop; tourId: string; contactId: string
  brokerageId: string; agentUserId: string; onDone: () => void
}) {
  const [isPending, startTransition] = useTransition()
  const [confirmedDate, setConfirmedDate]   = useState(stop.confirmed_time ? stop.confirmed_time.slice(0, 10) : '')
  const [confirmedTime, setConfirmedTime]   = useState(stop.confirmed_time ? stop.confirmed_time.slice(11, 16) : '')
  const [accessMethod, setAccessMethod]     = useState(stop.access_method ?? '')
  const [accessCode, setAccessCode]         = useState(stop.access_code ?? '')
  const [accessInstr, setAccessInstr]       = useState(stop.access_instructions ?? '')
  const [agentName, setAgentName]           = useState(stop.listing_agent_name ?? '')
  const [agentPhone, setAgentPhone]         = useState(stop.listing_agent_phone ?? '')
  const [agentCompany, setAgentCompany]     = useState(stop.listing_agent_company ?? '')
  const [schedRef, setSchedRef]             = useState(stop.scheduling_reference ?? '')

  const showCode = accessMethod === 'lockbox' || accessMethod === 'smart_lock'

  function handleConfirm() {
    if (!confirmedDate || !confirmedTime || !accessMethod) {
      toast({ title: 'Date, time, and access method are required', variant: 'destructive' })
      return
    }
    const confirmedTimestamp = `${confirmedDate}T${confirmedTime}:00`
    startTransition(async () => {
      const res = await confirmTourStop({
        tourStopId:          stop.id,
        showingId:           stop.showing_id ?? '',
        tourId,
        confirmedTime:       confirmedTimestamp,
        accessMethod,
        accessCode:          accessCode || undefined,
        accessInstructions:  accessInstr || undefined,
        listingAgentName:    agentName || undefined,
        listingAgentPhone:   agentPhone || undefined,
        listingAgentCompany: agentCompany || undefined,
        schedulingReference: schedRef || undefined,
        brokerageId,
        contactId,
        agentUserId,
      })
      if (res.success) {
        toast({ title: res.allConfirmed ? 'All stops confirmed!' : 'Stop confirmed' })
        onDone()
      } else {
        toast({ title: res.error ?? 'Failed to confirm stop', variant: 'destructive' })
      }
    })
  }

  return (
    <div className="space-y-4 pt-3">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label className="text-xs">Confirmed Date</Label>
          <Input type="date" value={confirmedDate} onChange={e => setConfirmedDate(e.target.value)} className="h-8 text-xs mt-1" />
        </div>
        <div>
          <Label className="text-xs">Confirmed Time</Label>
          <Input type="time" value={confirmedTime} onChange={e => setConfirmedTime(e.target.value)} className="h-8 text-xs mt-1" />
        </div>
      </div>

      <div>
        <Label className="text-xs">Access Method</Label>
        <Select value={accessMethod} onValueChange={setAccessMethod}>
          <SelectTrigger className="h-8 text-xs mt-1">
            <SelectValue placeholder="Select access method" />
          </SelectTrigger>
          <SelectContent>
            {ACCESS_METHODS.map(m => (
              <SelectItem key={m.value} value={m.value} className="text-xs">{m.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {showCode && (
        <div>
          <Label className="text-xs">Access Code</Label>
          <Input value={accessCode} onChange={e => setAccessCode(e.target.value)} className="h-8 text-xs mt-1" placeholder="e.g. 4821" />
        </div>
      )}

      <div>
        <Label className="text-xs">Special Instructions</Label>
        <Textarea
          value={accessInstr}
          onChange={e => setAccessInstr(e.target.value)}
          className="text-xs mt-1 min-h-[60px]"
          placeholder='e.g. "Enter through garage. Dog inside."'
        />
      </div>

      <div className="space-y-2">
        <p className="text-xs font-medium">Listing Agent</p>
        <div className="grid grid-cols-3 gap-2">
          <div>
            <Label className="text-xs">Name</Label>
            <Input value={agentName} onChange={e => setAgentName(e.target.value)} className="h-7 text-xs mt-0.5" />
          </div>
          <div>
            <Label className="text-xs">Company</Label>
            <Input value={agentCompany} onChange={e => setAgentCompany(e.target.value)} className="h-7 text-xs mt-0.5" />
          </div>
          <div>
            <Label className="text-xs">Phone</Label>
            <Input value={agentPhone} onChange={e => setAgentPhone(e.target.value)} className="h-7 text-xs mt-0.5" />
          </div>
        </div>
      </div>

      <div>
        <Label className="text-xs">Schedule Reference # (optional)</Label>
        <Input value={schedRef} onChange={e => setSchedRef(e.target.value)} className="h-8 text-xs mt-1" placeholder="ShowingTime # or notes" />
      </div>

      <Button onClick={handleConfirm} disabled={isPending} size="sm" className="w-full">
        {isPending ? 'Confirming...' : 'Mark Confirmed'}
      </Button>
    </div>
  )
}

export function TourConfirmTab({ tours, contactId, brokerageId, agentUserId, onRefresh, onBackToPlan }: TourConfirmTabProps) {
  const [expandedStopId, setExpandedStopId] = useState<string | null>(null)
  const [departureTime, setDepartureTime]   = useState('09:00')
  const [agentNotes, setAgentNotes]         = useState('')
  const [confirmingTourId, setConfirmingTourId] = useState<string | null>(null)
  const [isPending, startTransition]        = useTransition()
  // Route optimization per tour
  const [optimizingTourId, setOptimizingTourId] = useState<string | null>(null)
  const [routeResults, setRouteResults]         = useState<Record<string, any>>({})
  // AI schedule showing per stop
  const [schedulingStopId, setSchedulingStopId] = useState<string | null>(null)
  const [scheduleResults, setScheduleResults]   = useState<Record<string, any>>({})

  const activeTours = tours.filter(t => ['planned', 'confirmed'].includes(t.status))

  if (activeTours.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-48 gap-3">
        <p className="text-sm text-muted-foreground">No active tours to confirm. Create a tour plan first.</p>
        {onBackToPlan && (
          <Button variant="outline" size="sm" onClick={onBackToPlan}>
            <ArrowLeft className="h-3.5 w-3.5 mr-1.5" />
            Back to Plan
          </Button>
        )}
      </div>
    )
  }

  async function handleOptimizeRoute(tourId: string) {
    setOptimizingTourId(tourId)
    try {
      const res = await optimizeTourRoute(tourId)
      if (res.success) {
        setRouteResults(prev => ({ ...prev, [tourId]: res }))
        toast({ title: 'Route optimized — stops reordered for efficiency' })
        onRefresh()
      } else {
        toast({ title: (res as any).error ?? 'Route optimization failed', variant: 'destructive' })
      }
    } catch (err) {
      toast({ title: 'Route optimization failed', variant: 'destructive' })
    } finally {
      setOptimizingTourId(null)
    }
  }

  async function handleAIScheduleStop(stop: TourStop, tourDate: string) {
    // For agent seller listings, listing_id is a UUID.
    // For MLS buyer properties, listing_id is null — use mls_number or property_address as the identifier.
    const propertyIdentifier = stop.listing_id ?? stop.mls_number ?? stop.property_address
    if (!propertyIdentifier) {
      toast({ title: 'Cannot identify property for scheduling', variant: 'destructive' })
      return
    }
    setSchedulingStopId(stop.id)
    try {
      const res = await aiScheduleShowing({
        agentId:        agentUserId,
        propertyId:     propertyIdentifier,
        contactId,
        preferredDates: [tourDate],
        notes:          `Tour stop ${stop.order_index + 1}: ${stop.property_address}${stop.city ? ', ' + stop.city : ''}`,
      })
      if (res.success) {
        setScheduleResults(prev => ({ ...prev, [stop.id]: res }))
        toast({ title: 'Showing scheduled via AI' })
        onRefresh()
      } else {
        toast({ title: res.error ?? 'AI scheduling failed', variant: 'destructive' })
      }
    } catch (err) {
      toast({ title: 'AI scheduling failed', variant: 'destructive' })
    } finally {
      setSchedulingStopId(null)
    }
  }

  function handleConfirmTour(tourId: string) {
    setConfirmingTourId(tourId)
    startTransition(async () => {
      // confirmTour now routes to finalizeTour — sends report + per-stop
      // calendar events. Channels default to portal; agent picks email/SMS
      // via reportChannels in the future-state UI.
      const res = await confirmTour({ tourId, brokerageId, contactId, agentUserId, departureTime, agentNotes, reportChannels: ['portal','email'] })
      if (res.success) {
        toast({ title: 'Tour confirmed — report sent to buyer' })
        onRefresh()
      } else {
        toast({ title: res.error ?? 'Failed to confirm tour', variant: 'destructive' })
      }
      setConfirmingTourId(null)
    })
  }

  // Step 1 (after AI draft): dispatch scheduling outreach to listing agents.
  // Flips tour status from 'planned' → 'scheduling'. Each stop's outreach
  // (ShowingTime API call OR direct text/email) is queued; per-stop
  // is_confirmed flips to true via confirmTourStop as listing agents reply.
  function handleScheduleStops(tourId: string) {
    setConfirmingTourId(tourId)
    startTransition(async () => {
      const res = await scheduleTourStops({ tourId, agentUserId, brokerageId })
      if (res.success) {
        toast({
          title: `Scheduling started — ${res.dispatched ?? 0} listing agents contacted`,
          description: 'Confirm each stop as listing agents reply, then finalize the tour.',
        })
        onRefresh()
      } else {
        toast({ title: res.error ?? 'Failed to start scheduling', variant: 'destructive' })
      }
      setConfirmingTourId(null)
    })
  }

  return (
    <div className="space-y-8">
      {activeTours.map(tour => {
        const sortedStops    = [...tour.tour_stops].sort((a, b) => a.order_index - b.order_index)
        const confirmedCount = sortedStops.filter(s => s.is_confirmed).length
        const mapUrl         = buildMapUrl(sortedStops)

        return (
          <div key={tour.id} className="space-y-4">
            {/* Tour header */}
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div>
                <p className="text-sm font-semibold">{formatDate(tour.tour_date)}</p>
                <p className="text-xs text-muted-foreground">
                  {confirmedCount}/{sortedStops.length} stops confirmed
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="text-xs gap-1.5"
                  onClick={() => handleOptimizeRoute(tour.id)}
                  disabled={optimizingTourId === tour.id || sortedStops.length < 2}
                >
                  {optimizingTourId === tour.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Route className="h-3.5 w-3.5" />
                  )}
                  Optimize Route
                </Button>
                <Badge variant={tour.status === 'confirmed' ? 'default' : 'secondary'}>
                  {tour.status}
                </Badge>
              </div>
            </div>

            {/* Route optimization result */}
            {routeResults[tour.id] && (
              <div className="p-2 bg-blue-50 border border-blue-100 rounded-md text-xs text-blue-800">
                {routeResults[tour.id].summary ?? 'Route optimized — stops reordered for minimum drive time.'}
                {routeResults[tour.id].estimatedDriveMins != null && (
                  <span className="ml-2 font-medium">
                    ~{routeResults[tour.id].estimatedDriveMins} min total drive time
                  </span>
                )}
              </div>
            )}

            {/* Map placeholder */}
            {mapUrl ? (
              <div className="rounded-lg overflow-hidden border h-40">
                <img src={mapUrl} alt="Tour route map" className="w-full h-full object-cover" />
              </div>
            ) : (
              <div className="rounded-lg border bg-muted/40 p-3 space-y-1">
                <div className="flex items-center gap-1.5 mb-2">
                  <MapPin className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="text-xs font-medium text-muted-foreground">Tour Route</span>
                </div>
                {sortedStops.map((s, i) => (
                  <div key={s.id} className="flex items-start gap-2">
                    <span className="flex-shrink-0 w-5 h-5 rounded-full bg-primary text-primary-foreground text-[10px] font-bold flex items-center justify-center">
                      {i + 1}
                    </span>
                    <p className="text-xs text-muted-foreground leading-tight pt-0.5">
                      {s.property_address}{s.city ? `, ${s.city}` : ''}
                    </p>
                  </div>
                ))}
              </div>
            )}

            {/* Stop-by-stop confirm list */}
            <div className="space-y-2">
              {sortedStops.map(stop => {
                const isExpanded = expandedStopId === stop.id
                return (
                  <Card key={stop.id} className={stop.is_confirmed ? 'border-green-200 bg-green-50/30' : ''}>
                    <CardContent className="p-0">
                      <button
                        onClick={() => setExpandedStopId(isExpanded ? null : stop.id)}
                        className="w-full flex items-center justify-between px-4 py-3 text-left"
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          {stop.is_confirmed
                            ? <CheckCircle className="h-4 w-4 text-green-600 shrink-0" />
                            : <Clock className="h-4 w-4 text-muted-foreground shrink-0" />
                          }
                          <div className="min-w-0">
                            <p className="text-sm font-medium truncate">
                              Stop {stop.order_index + 1} — {stop.property_address}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {stop.is_confirmed && stop.confirmed_time
                                ? new Date(stop.confirmed_time).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
                                : 'Pending confirmation'}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <Badge variant={stop.is_confirmed ? 'default' : 'outline'} className="text-xs">
                            {stop.is_confirmed ? 'confirmed' : 'pending'}
                          </Badge>
                          {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                        </div>
                      </button>

                      {isExpanded && (
                        <div className="px-4 pb-4 border-t space-y-3">
                          {/* AI Schedule Showing — works for both agent listings (listing_id) and MLS properties (mls_number/address) */}
                          {!stop.is_confirmed && (
                            <div className="pt-3 flex items-center gap-2">
                              <Button
                                size="sm"
                                variant="outline"
                                className="text-xs gap-1.5"
                                onClick={() => handleAIScheduleStop(stop, tour.tour_date)}
                                disabled={schedulingStopId === stop.id}
                              >
                                {schedulingStopId === stop.id ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <CalendarPlus className="h-3.5 w-3.5" />
                                )}
                                AI Schedule Showing
                              </Button>
                              {scheduleResults[stop.id] && (
                                <span className="text-xs text-emerald-600 flex items-center gap-1">
                                  <CheckCircle className="h-3 w-3" />
                                  Scheduled
                                </span>
                              )}
                            </div>
                          )}
                          <StopConfirmForm
                            stop={stop}
                            tourId={tour.id}
                            contactId={contactId}
                            brokerageId={brokerageId}
                            agentUserId={agentUserId}
                            onDone={() => { setExpandedStopId(null); onRefresh() }}
                          />
                        </div>
                      )}
                    </CardContent>
                  </Card>
                )
              })}
            </div>

            {/* Departure time + agent notes */}
            <div className="space-y-3 pt-2 border-t">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs">Departure Time</Label>
                  <Input
                    type="time"
                    value={departureTime}
                    onChange={e => setDepartureTime(e.target.value)}
                    className="h-8 text-xs mt-1"
                  />
                </div>
              </div>
              <div>
                <Label className="text-xs">Agent Notes for Buyer</Label>
                <Textarea
                  value={agentNotes}
                  onChange={e => setAgentNotes(e.target.value)}
                  placeholder="e.g. Meet in front — parking on street is fine."
                  className="text-xs mt-1 min-h-[72px]"
                />
              </div>
            </div>

            {/* Action buttons — three-step flow:
                  planned    → "Schedule Showings" (dispatches outreach)
                  scheduling → "Finalize Tour" (locks tour, sends report)
                  confirmed  → already done, button disabled */}
            <div className="flex gap-3 flex-wrap">
              {onBackToPlan && (
                <Button variant="outline" size="sm" onClick={onBackToPlan} className="gap-1.5">
                  <ArrowLeft className="h-3.5 w-3.5" />
                  Back to Plan
                </Button>
              )}
              {tour.status === 'planned' && (
                <Button
                  className="flex-1"
                  disabled={isPending}
                  onClick={() => handleScheduleStops(tour.id)}
                >
                  {isPending && confirmingTourId === tour.id
                    ? 'Dispatching...'
                    : `Schedule Showings (${sortedStops.length})`}
                </Button>
              )}
              {(tour.status === 'scheduling' || tour.status === 'confirmed') && (
                <Button
                  className="flex-1"
                  disabled={isPending || tour.status === 'confirmed'}
                  onClick={() => handleConfirmTour(tour.id)}
                >
                  {isPending && confirmingTourId === tour.id
                    ? 'Finalizing...'
                    : tour.status === 'confirmed'
                      ? 'Tour Confirmed'
                      : `Finalize Tour (${confirmedCount}/${sortedStops.length} confirmed)`}
                </Button>
              )}
            </div>
            {tour.status === 'scheduling' && confirmedCount < sortedStops.length && (
              <p className="text-xs text-muted-foreground -mt-1">
                Confirm each stop above as listing agents reply. You can still finalize with unconfirmed stops — they will go out as suggested times.
              </p>
            )}
          </div>
        )
      })}
    </div>
  )
}
