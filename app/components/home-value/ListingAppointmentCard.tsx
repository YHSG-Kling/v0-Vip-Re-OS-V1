"use client"

/**
 * <ListingAppointmentCard> — THE ≥7-DAY BOOKING, on both surfaces.
 *
 * The owner's ruling: "both the email and the portal will be given a way to
 * schedule a listing appotintment as well which needs to be atleast 7 days out."
 *
 * ONE component, mounted in two places, so the two surfaces cannot drift:
 *   · the seller's own report page (/home-value/result/[requestId]) — where the
 *     email's "Schedule a listing appointment" button lands, no login needed
 *   · the contact portal, inside <HomeValueReportCard> on the portal home
 *
 * This is NOT the walk-through booking. <AppointmentBookingCard> next to it books
 * the EVALUATION appointment (48-hour floor) — the agent coming to look at the
 * house. This one books the LISTING appointment: the sit-down where the agent
 * presents the pricing strategy and the marketing plan and asks for the listing.
 *
 * The 7-day floor is not enforced here. getListingAppointmentSlots only OFFERS
 * times at or beyond it, and scheduleSellerListingAppointment refuses anything
 * earlier server-side — this component just never shows a time that would be
 * refused, and prints the rule so the seller knows why the first option is a
 * week out rather than thinking the agent has no availability.
 */

import { useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { CalendarClock, CheckCircle2, User, ChevronDown, ChevronUp } from "lucide-react"
import { getListingAppointmentSlots, scheduleSellerListingAppointment } from "@/app/actions/home-value"
import { LISTING_APPOINTMENT_MIN_LEAD_DAYS } from "@/lib/home-value/listing-appointment"

interface Slot {
  startAt: string
  endAt: string
  label: string
}

interface AgentOption {
  id: string
  userId: string
  firstName: string
  lastName: string
  phone: string | null
  email: string | null
  profileImageUrl: string | null
  slots: Slot[]
}

interface Props {
  brokerageId: string
  contactId: string
  propertyAddress: string
  /** The HOMEOWNER's name — it is stamped on the appointment and told to the agent. */
  contactName: string
}

export function ListingAppointmentCard({
  brokerageId,
  contactId,
  propertyAddress,
  contactName,
}: Props) {
  const [agents, setAgents] = useState<AgentOption[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedAgent, setSelectedAgent] = useState<AgentOption | null>(null)
  const [selectedSlot, setSelectedSlot] = useState<Slot | null>(null)
  const [showAllSlots, setShowAllSlots] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [confirmed, setConfirmed] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    getListingAppointmentSlots(brokerageId).then((res) => {
      if (!live) return
      if (res.success && res.agents?.length) {
        setAgents(res.agents)
        if (res.agents.length === 1) setSelectedAgent(res.agents[0])
      } else {
        setError(
          res.error ??
            "No listing appointment times are open right now — your agent will reach out to find one.",
        )
      }
      setLoading(false)
    })
    return () => {
      live = false
    }
  }, [brokerageId])

  async function handleBook() {
    if (!selectedAgent || !selectedSlot) return
    setSubmitting(true)
    setError(null)
    const res = await scheduleSellerListingAppointment({
      contactId,
      agentId: selectedAgent.id,
      brokerageId,
      startAt: selectedSlot.startAt,
      endAt: selectedSlot.endAt,
      propertyAddress,
      contactName,
    })
    setSubmitting(false)
    if (res.success) {
      setConfirmed(selectedSlot.label)
    } else {
      // Includes the server's ≥7-day refusal when a stale slot list is posted.
      setError(res.error ?? "Booking failed. Please try another time.")
      setSelectedSlot(null)
    }
  }

  if (confirmed) {
    return (
      <Card id="listing-appointment" className="border-indigo-200 bg-indigo-50">
        <CardContent className="py-10 flex flex-col items-center gap-3 text-center">
          <CheckCircle2 className="h-10 w-10 text-indigo-600" />
          <h3 className="text-lg font-semibold text-indigo-900">Listing Appointment Confirmed</h3>
          <p className="text-sm text-indigo-800">
            Your listing appointment is set for <span className="font-semibold">{confirmed}</span>.
          </p>
          <p className="text-xs text-indigo-700">
            {selectedAgent?.firstName} {selectedAgent?.lastName} will send your listing plan ahead of the meeting.
          </p>
        </CardContent>
      </Card>
    )
  }

  const visibleSlots = selectedAgent
    ? showAllSlots
      ? selectedAgent.slots
      : selectedAgent.slots.slice(0, 6)
    : []

  return (
    <Card id="listing-appointment" className="border-indigo-200">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <CalendarClock className="h-5 w-5 text-indigo-600" />
          Schedule a Listing Appointment
        </CardTitle>
        <CardDescription>
          The sit-down where you&apos;ll see the pricing strategy and the full marketing plan for{" "}
          {propertyAddress}. We book these at least {LISTING_APPOINTMENT_MIN_LEAD_DAYS} days out so
          there&apos;s time to prepare your listing plan properly before we meet.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {loading && (
          <div className="space-y-3">
            <Skeleton className="h-12 w-full" />
            <div className="grid grid-cols-2 gap-2">
              {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
            </div>
          </div>
        )}

        {!loading && error && agents.length === 0 && (
          <p className="text-sm text-muted-foreground text-center py-4">{error}</p>
        )}

        {!loading && agents.length > 0 && (
          <>
            {error && (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            )}

            {agents.length > 1 && (
              <div>
                <p className="text-sm font-medium text-foreground mb-3">Select an Agent</p>
                <div className="flex flex-wrap gap-3">
                  {agents.map((agent) => (
                    <button
                      key={agent.id}
                      type="button"
                      onClick={() => {
                        setSelectedAgent(agent)
                        setSelectedSlot(null)
                        setShowAllSlots(false)
                      }}
                      className={`flex items-center gap-2 px-4 py-2 rounded-lg border text-sm transition-colors ${
                        selectedAgent?.id === agent.id
                          ? "border-indigo-500 bg-indigo-50 text-indigo-700 font-medium"
                          : "border-border hover:border-indigo-300"
                      }`}
                    >
                      {agent.profileImageUrl ? (
                        <img
                          src={agent.profileImageUrl}
                          alt={`${agent.firstName} ${agent.lastName}`}
                          className="h-6 w-6 rounded-full object-cover"
                        />
                      ) : (
                        <User className="h-4 w-4 text-muted-foreground" />
                      )}
                      {agent.firstName} {agent.lastName}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {agents.length === 1 && selectedAgent && (
              <div className="flex items-center gap-3 p-3 bg-muted/40 rounded-lg">
                {selectedAgent.profileImageUrl ? (
                  <img
                    src={selectedAgent.profileImageUrl}
                    alt={`${selectedAgent.firstName} ${selectedAgent.lastName}`}
                    className="h-10 w-10 rounded-full object-cover border"
                  />
                ) : (
                  <div className="h-10 w-10 rounded-full bg-muted flex items-center justify-center">
                    <User className="h-5 w-5 text-muted-foreground" />
                  </div>
                )}
                <div>
                  <p className="font-medium text-sm text-foreground">
                    {selectedAgent.firstName} {selectedAgent.lastName}
                  </p>
                  <p className="text-xs text-muted-foreground">Listing Agent</p>
                </div>
              </div>
            )}

            {selectedAgent && (
              <div>
                <p className="text-sm font-medium text-foreground mb-1">Select a Time</p>
                <p className="text-xs text-muted-foreground mb-3">
                  Earliest available is {LISTING_APPOINTMENT_MIN_LEAD_DAYS} days from today.
                </p>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {visibleSlots.map((slot) => (
                    <button
                      key={slot.startAt}
                      type="button"
                      onClick={() => setSelectedSlot(slot)}
                      className={`px-3 py-2 rounded-lg border text-xs text-left transition-colors ${
                        selectedSlot?.startAt === slot.startAt
                          ? "border-indigo-600 bg-indigo-600 text-white font-medium"
                          : "border-border hover:border-indigo-400 text-foreground"
                      }`}
                    >
                      {slot.label}
                    </button>
                  ))}
                </div>

                {selectedAgent.slots.length > 6 && (
                  <button
                    type="button"
                    onClick={() => setShowAllSlots((v) => !v)}
                    className="mt-2 flex items-center gap-1 text-xs text-indigo-700 hover:underline"
                  >
                    {showAllSlots ? (
                      <><ChevronUp className="h-3 w-3" /> Show fewer times</>
                    ) : (
                      <><ChevronDown className="h-3 w-3" /> Show {selectedAgent.slots.length - 6} more times</>
                    )}
                  </button>
                )}
              </div>
            )}

            {selectedSlot && (
              <div className="pt-2 space-y-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge variant="outline" className="text-xs">{selectedSlot.label}</Badge>
                  <Badge variant="outline" className="text-xs">
                    {selectedAgent?.firstName} {selectedAgent?.lastName}
                  </Badge>
                </div>
                <Button onClick={handleBook} disabled={submitting} className="w-full sm:w-auto">
                  {submitting ? "Booking..." : "Confirm Listing Appointment"}
                </Button>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
