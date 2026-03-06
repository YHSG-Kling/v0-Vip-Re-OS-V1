'use client'

import { useState, useTransition } from 'react'
import { ChevronDown, ChevronRight, CheckCircle, Clock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { toast } from '@/hooks/use-toast'
import { confirmTourStop } from '@/app/actions/tour-planner'

interface TourStop {
  id: string
  tour_id: string
  order_index: number
  property_address: string
  city: string | null
  state: string | null
  zip: string | null
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
  tour_stops: TourStop[]
}

interface TourConfirmTabProps {
  tours: Tour[]
  contactId: string
  brokerageId: string
  agentUserId: string
  onRefresh: () => void
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

export function TourConfirmTab({ tours, contactId, brokerageId, agentUserId, onRefresh }: TourConfirmTabProps) {
  const [expandedStopId, setExpandedStopId] = useState<string | null>(null)

  const activeTours = tours.filter(t => ['planned', 'confirmed'].includes(t.status))

  if (activeTours.length === 0) {
    return (
      <div className="flex items-center justify-center h-48">
        <p className="text-sm text-muted-foreground">No active tours to confirm. Create a tour plan first.</p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {activeTours.map(tour => {
        const sortedStops = [...tour.tour_stops].sort((a, b) => a.order_index - b.order_index)
        const confirmedCount = sortedStops.filter(s => s.is_confirmed).length

        return (
          <div key={tour.id}>
            <div className="flex items-center justify-between mb-3">
              <div>
                <p className="text-sm font-semibold">{formatDate(tour.tour_date)}</p>
                <p className="text-xs text-muted-foreground">
                  {confirmedCount}/{sortedStops.length} stops confirmed
                </p>
              </div>
              <Badge variant={tour.all_confirmed ? 'default' : 'secondary'}>
                {tour.status}
              </Badge>
            </div>

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
                        <div className="px-4 pb-4 border-t">
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
          </div>
        )
      })}
    </div>
  )
}
