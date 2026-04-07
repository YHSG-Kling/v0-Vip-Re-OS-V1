"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { Calendar, CheckCircle2, User, ChevronDown, ChevronUp } from "lucide-react"
import { getAvailableAgentSlots, scheduleHomeValuationAppt } from "@/app/actions/home-value"

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
  contactName: string
}

export function AppointmentBookingCard({
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
    getAvailableAgentSlots(brokerageId).then((res) => {
      if (res.success && res.agents?.length) {
        setAgents(res.agents)
        // Auto-select single agent
        if (res.agents.length === 1) setSelectedAgent(res.agents[0])
      } else {
        setError("No agents available for scheduling right now.")
      }
      setLoading(false)
    })
  }, [brokerageId])

  async function handleBook() {
    if (!selectedAgent || !selectedSlot) return
    setSubmitting(true)
    const res = await scheduleHomeValuationAppt({
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
      setError(res.error ?? "Booking failed. Please try another time.")
      setSelectedSlot(null)
    }
  }

  if (confirmed) {
    return (
      <Card className="border-green-200 bg-green-50">
        <CardContent className="py-10 flex flex-col items-center gap-3 text-center">
          <CheckCircle2 className="h-10 w-10 text-green-600" />
          <h3 className="text-lg font-semibold text-green-900">Appointment Confirmed</h3>
          <p className="text-sm text-green-800">
            Your home valuation appointment is set for{" "}
            <span className="font-semibold">{confirmed}</span>.
          </p>
          <p className="text-xs text-green-700">
            {selectedAgent?.firstName} {selectedAgent?.lastName} will be in touch to confirm details.
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
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <Calendar className="h-5 w-5" />
          Schedule a Home Valuation Appointment
        </CardTitle>
        <CardDescription>
          Meet with one of our listing agents for an accurate, in-person assessment of your home.
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

        {!loading && error && (
          <p className="text-sm text-muted-foreground text-center py-4">{error}</p>
        )}

        {!loading && !error && (
          <>
            {/* Agent selection — only shown when multiple agents available */}
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
                          ? "border-primary bg-primary/5 text-primary font-medium"
                          : "border-border hover:border-primary/50"
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

            {/* Single agent display */}
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

            {/* Time slot grid */}
            {selectedAgent && (
              <div>
                <p className="text-sm font-medium text-foreground mb-3">Select a Time</p>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {visibleSlots.map((slot) => (
                    <button
                      key={slot.startAt}
                      type="button"
                      onClick={() => setSelectedSlot(slot)}
                      className={`px-3 py-2 rounded-lg border text-xs text-left transition-colors ${
                        selectedSlot?.startAt === slot.startAt
                          ? "border-primary bg-primary text-primary-foreground font-medium"
                          : "border-border hover:border-primary/60 text-foreground"
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
                    className="mt-2 flex items-center gap-1 text-xs text-primary hover:underline"
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

            {/* Confirm button */}
            {selectedSlot && (
              <div className="pt-2 space-y-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge variant="outline" className="text-xs">
                    {selectedSlot.label}
                  </Badge>
                  <Badge variant="outline" className="text-xs">
                    {selectedAgent?.firstName} {selectedAgent?.lastName}
                  </Badge>
                </div>
                <Button
                  onClick={handleBook}
                  disabled={submitting}
                  className="w-full sm:w-auto"
                >
                  {submitting ? "Booking..." : "Confirm Appointment"}
                </Button>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
