"use client"

import { useState, useTransition } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { AlertCircle, RefreshCw, CalendarCheck, BarChart2, Plus, Loader2 } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import ShowingRequestsPanel from "@/app/components/dashboard/listings/showings/showing-requests-panel"
import ConfirmedShowingsList from "@/app/components/dashboard/listings/showings/confirmed-showings-list"
import FeedbackSummaryPanel from "@/app/components/dashboard/listings/showings/feedback-summary-panel"
import ShowingTimeBanner from "@/app/components/dashboard/listings/showings/showingtime-banner"
import { syncShowingTimeShowings } from "@/app/actions/seller-showings"
import { createShowing } from "@/app/actions/showings"
import { toast } from "sonner"

interface Props {
  listing: {
    id: string
    address: string
    city: string | null
    state: string | null
    agent_id: string | null
    lifecycle_stage: string
    showing_instructions: string | null
  }
  brokerageId: string
  agentUserId: string
  mode: { mode: "showingtime" | "manual"; credentialId?: string }
  initialRequests: any[]
  initialShowings: any[]
  analytics: any
  feedbackCards: any[]
}

export default function ShowingsClient({
  listing,
  brokerageId,
  agentUserId,
  mode,
  initialRequests,
  initialShowings,
  analytics,
  feedbackCards,
}: Props) {
  const [requests, setRequests] = useState(initialRequests)
  const [showings, setShowings] = useState(initialShowings)
  const [isSyncing, startSync] = useTransition()
  const [scheduleOpen, setScheduleOpen] = useState(false)
  const [contactId, setContactId] = useState("")
  const [scheduleDate, setScheduleDate] = useState("")
  const [scheduleTime, setScheduleTime] = useState("")
  const [isScheduling, startSchedule] = useTransition()

  const fullAddress = [listing.address, listing.city, listing.state].filter(Boolean).join(", ")

  function handleScheduleShowing() {
    if (!contactId || !scheduleDate || !scheduleTime) {
      toast.error("Please fill in all fields")
      return
    }
    startSchedule(async () => {
      const result = await createShowing({
        contactId,
        propertyId: listing.id,
        propertyAddress: fullAddress,
        scheduledDate: scheduleDate,
        scheduledTime: scheduleTime,
        agentId: agentUserId,
      })
      if (result.success) {
        toast.success("Showing scheduled")
        setScheduleOpen(false)
        setContactId("")
        setScheduleDate("")
        setScheduleTime("")
      } else {
        toast.error(result.error ?? "Failed to schedule showing")
      }
    })
  }

  function handleSync() {
    if (!mode.credentialId) return
    startSync(async () => {
      await syncShowingTimeShowings({
        listingId: listing.id,
        brokerageId,
        credentialId: mode.credentialId!,
      })
      // Page will revalidate via revalidatePath in server action
    })
  }

  return (
    <div className="flex flex-col gap-6 p-6">
      {/* Schedule Showing Dialog */}
      <Dialog open={scheduleOpen} onOpenChange={setScheduleOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Schedule Showing</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="contact-id">Buyer Contact ID</Label>
              <Input
                id="contact-id"
                placeholder="Contact UUID..."
                value={contactId}
                onChange={e => setContactId(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sched-date">Date</Label>
              <Input
                id="sched-date"
                type="date"
                value={scheduleDate}
                onChange={e => setScheduleDate(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sched-time">Time</Label>
              <Input
                id="sched-time"
                type="time"
                value={scheduleTime}
                onChange={e => setScheduleTime(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setScheduleOpen(false)}>Cancel</Button>
            <Button onClick={handleScheduleShowing} disabled={isScheduling}>
              {isScheduling ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <CalendarCheck className="h-4 w-4 mr-1.5" />}
              Confirm Showing
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Header */}
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Showings</h1>
          <p className="text-sm text-muted-foreground">{fullAddress}</p>
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            onClick={() => setScheduleOpen(true)}
            className="gap-2"
          >
            <Plus className="h-4 w-4" />
            Schedule Showing
          </Button>
          {mode.mode === "showingtime" && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleSync}
              disabled={isSyncing}
              className="gap-2"
            >
              <RefreshCw className={`h-4 w-4 ${isSyncing ? "animate-spin" : ""}`} />
              Sync from ShowingTime
            </Button>
          )}
        </div>
      </div>

      {/* ShowingTime / Manual mode banner */}
      {mode.mode === "showingtime" ? (
        <ShowingTimeBanner />
      ) : (
        <Card className="border-dashed border-muted-foreground/30 bg-muted/20">
          <CardContent className="flex items-start gap-3 py-4">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <div>
              <p className="text-sm font-medium text-foreground">Manual mode</p>
              <p className="text-sm text-muted-foreground">
                Connect ShowingTime in{" "}
                <a href="/dashboard/settings/integrations" className="underline hover:text-foreground">
                  Settings &rarr; Integrations
                </a>{" "}
                to sync showings automatically.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Main two-panel layout */}
      <div className="flex flex-col gap-6 lg:flex-row">
        {/* Left: requests + confirmed showings */}
        <div className="flex flex-1 flex-col gap-6">
          {/* Pending requests — manual mode only */}
          {mode.mode === "manual" && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <CalendarCheck className="h-4 w-4" />
                  Pending Requests
                  {requests.length > 0 && (
                    <Badge variant="destructive" className="ml-1 text-xs">
                      {requests.length}
                    </Badge>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <ShowingRequestsPanel
                  requests={requests}
                  listing={listing}
                  brokerageId={brokerageId}
                  agentUserId={agentUserId}
                  onUpdate={setRequests}
                />
              </CardContent>
            </Card>
          )}

          {/* Confirmed showings */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <BarChart2 className="h-4 w-4" />
                Showings
                <span className="ml-1 text-sm font-normal text-muted-foreground">
                  ({showings.length})
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <ConfirmedShowingsList
                showings={showings}
                listing={listing}
                brokerageId={brokerageId}
                agentUserId={agentUserId}
                mode={mode}
                onUpdate={setShowings}
              />
            </CardContent>
          </Card>
        </div>

        {/* Right: feedback summary panel (300px) */}
        <div className="w-full lg:w-[300px] lg:shrink-0">
          <FeedbackSummaryPanel
            analytics={analytics}
            feedbackCards={feedbackCards}
          />
        </div>
      </div>
    </div>
  )
}
