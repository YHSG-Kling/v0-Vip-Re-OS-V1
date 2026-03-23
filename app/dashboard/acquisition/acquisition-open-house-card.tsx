"use client"

import { useState, useTransition } from "react"
import Link from "next/link"
import { Home, ArrowRight, Loader2, QrCode } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useToast } from "@/hooks/use-toast"
import { createOpenHouseEvent } from "@/app/actions/open-house-automation"

type Attendee = {
  id: string
  created_at: string
  check_in_time: string | null
  event: { agent_id: string; listing_id: string | null; event_date: string } | null
  contact: { first_name: string | null; last_name: string | null; email: string | null } | null
}

type Listing = {
  id: string
  address: string
  city: string | null
  state: string | null
}

interface Props {
  openHouseLeads: Attendee[]
  openHouseCount: number
  agentId: string
  activeListings: Listing[]
}

export function AcquisitionOpenHouseCard({
  openHouseLeads,
  openHouseCount,
  agentId,
  activeListings,
}: Props) {
  const [showCreate, setShowCreate] = useState(false)
  const [selectedListingId, setSelectedListingId] = useState<string>("")
  const [eventDate, setEventDate] = useState("")
  const [startTime, setStartTime] = useState("10:00")
  const [endTime, setEndTime] = useState("12:00")
  const [createdEventId, setCreatedEventId] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()
  const { toast } = useToast()

  function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    if (!selectedListingId) {
      toast({ title: "Select a listing first", variant: "destructive" })
      return
    }
    if (!eventDate) {
      toast({ title: "Select an event date", variant: "destructive" })
      return
    }
    startTransition(async () => {
      const result = await createOpenHouseEvent({
        agentId,
        propertyId: selectedListingId,
        eventDate,
        startTime,
        endTime,
      })
      if (result.success && result.data) {
        setCreatedEventId(result.data.id)
        toast({ title: "Open house created", description: `Event on ${eventDate}` })
      } else {
        toast({
          title: "Failed to create open house",
          description: result.error ?? "Unknown error",
          variant: "destructive",
        })
      }
    })
  }

  return (
    <Card className="flex flex-col">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2">
            <div className="rounded-md bg-muted p-2">
              <Home className="h-4 w-4 text-foreground" aria-hidden="true" />
            </div>
            <CardTitle className="text-base">Open House Sign-In</CardTitle>
          </div>
          {openHouseCount > 0 && (
            <Badge variant="secondary">{openHouseCount} this month</Badge>
          )}
        </div>
        <p className="text-sm text-muted-foreground leading-relaxed">
          Digital sign-in that creates contacts automatically. No paper, no follow-up friction.
        </p>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 flex-1">
        {openHouseLeads.length > 0 ? (
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Recent captures</p>
            {openHouseLeads.map((attendee) => {
              const name = [
                attendee.contact?.first_name,
                attendee.contact?.last_name,
              ]
                .filter(Boolean)
                .join(" ") || attendee.contact?.email || "Unknown"
              return (
                <div key={attendee.id} className="flex items-center justify-between text-sm">
                  <span className="text-foreground">{name}</span>
                  <span className="text-xs text-muted-foreground">
                    {new Date(attendee.created_at).toLocaleDateString()}
                  </span>
                </div>
              )
            })}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No sign-ins this month.</p>
        )}

        {/* Quick-create form */}
        <div className="border-t border-border pt-3">
          <button
            type="button"
            className="text-sm font-medium text-foreground flex items-center gap-1.5 hover:text-primary transition-colors"
            onClick={() => setShowCreate((v) => !v)}
            aria-expanded={showCreate}
          >
            <QrCode className="h-3.5 w-3.5" aria-hidden="true" />
            {showCreate ? "Hide form" : "Create sign-in link for today"}
          </button>

          {showCreate && (
            <div className="mt-3">
              {createdEventId ? (
                <div className="flex flex-col gap-2">
                  <p className="text-sm font-medium text-foreground">Open house created.</p>
                  <Link href={`/open-house/${createdEventId}/signin`}>
                    <Button size="sm" className="w-full gap-2">
                      Open Sign-In Page
                      <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                    </Button>
                  </Link>
                  <Button
                    size="sm"
                    variant="outline"
                    className="w-full"
                    onClick={() => { setCreatedEventId(null); setEventDate(""); setSelectedListingId("") }}
                  >
                    Create Another
                  </Button>
                </div>
              ) : (
                <form onSubmit={handleCreate} className="space-y-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="oh-listing" className="text-sm">Listing</Label>
                    {activeListings.length > 0 ? (
                      <Select value={selectedListingId} onValueChange={setSelectedListingId}>
                        <SelectTrigger id="oh-listing">
                          <SelectValue placeholder="Select a listing" />
                        </SelectTrigger>
                        <SelectContent>
                          {activeListings.map((l) => (
                            <SelectItem key={l.id} value={l.id}>
                              {l.address}{l.city ? `, ${l.city}` : ""}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        No active listings.{" "}
                        <Link href="/dashboard/listings" className="text-primary underline underline-offset-2">
                          Add one first.
                        </Link>
                      </p>
                    )}
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="oh-date" className="text-sm">Event Date</Label>
                    <Input
                      id="oh-date"
                      type="date"
                      value={eventDate}
                      min={new Date().toISOString().split("T")[0]}
                      onChange={(e) => setEventDate(e.target.value)}
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label htmlFor="oh-start" className="text-sm">Start</Label>
                      <Input
                        id="oh-start"
                        type="time"
                        value={startTime}
                        onChange={(e) => setStartTime(e.target.value)}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="oh-end" className="text-sm">End</Label>
                      <Input
                        id="oh-end"
                        type="time"
                        value={endTime}
                        onChange={(e) => setEndTime(e.target.value)}
                      />
                    </div>
                  </div>
                  {activeListings.length > 0 && (
                    <Button
                      type="submit"
                      size="sm"
                      className="w-full gap-2"
                      disabled={isPending || !selectedListingId || !eventDate}
                    >
                      {isPending ? (
                        <>
                          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                          Creating...
                        </>
                      ) : (
                        "Create Sign-In Link"
                      )}
                    </Button>
                  )}
                </form>
              )}
            </div>
          )}
        </div>

        <div className="mt-auto flex flex-col gap-2">
          <Link href="/dashboard/listings">
            <Button className="w-full gap-2" size="sm">
              View Open Houses
              <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
            </Button>
          </Link>
        </div>
      </CardContent>
    </Card>
  )
}
