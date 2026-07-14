"use client"

/**
 * STRATEGY SESSION card (concierge list #24) — the OS detects the moment
 * (offers on the table, a listing going stale, a fresh launch, a buyer
 * kickoff), prepares the agenda from the real numbers, and drafts the warm
 * invite. One click turns it into the agent's task with the whole packet.
 */

import { useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { CalendarClock, Loader2, Check } from "lucide-react"
import {
  getStrategySessionAction,
  scheduleStrategySessionAction,
  setSellerFloorAction,
} from "@/app/actions/strategy-session"
import type { StrategySession } from "@/lib/kernel/strategy-session"

const MOMENT_LABELS: Record<string, string> = {
  offer_decision: "Offers on the table",
  price_change: "Pricing crossroads",
  listing_launch: "Listing launch",
  buyer_kickoff: "Buyer kickoff",
}

export function StrategySessionCard({ contactId }: { contactId: string }) {
  const [session, setSession] = useState<StrategySession | null>(null)
  const [listingId, setListingId] = useState<string | null>(null)
  const [floor, setFloor] = useState("")
  const [floorSaved, setFloorSaved] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [scheduled, setScheduled] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const prepare = () => {
    setError(null)
    startTransition(async () => {
      const r = await getStrategySessionAction({ contactId })
      if (r.ok) { setSession(r.session); setListingId(r.listingId ?? null); setLoaded(true) }
      else setError(r.error)
    })
  }

  const schedule = () => {
    if (!session) return
    setError(null)
    startTransition(async () => {
      const r = await scheduleStrategySessionAction({ contactId, session })
      if (r.ok) setScheduled(true)
      else setError(r.error)
    })
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <CalendarClock className="h-4 w-4 text-indigo-600" /> Strategy session
          {session && (
            <Badge className="bg-indigo-100 text-indigo-800 text-[10px]">{MOMENT_LABELS[session.moment] ?? session.moment}</Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {!loaded ? (
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              Big moments deserve a sit-down, not a text thread. The OS detects the moment and prepares the agenda.
            </p>
            <Button size="sm" variant="outline" className="h-7 text-xs shrink-0" onClick={prepare} disabled={pending}>
              {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : null} Prepare the session
            </Button>
          </div>
        ) : !session ? (
          <p className="text-xs text-muted-foreground">
            No strategy moment right now — no active listing, offers, or buyer journey to plan around.
          </p>
        ) : (
          <>
            <p className="text-sm font-medium">{session.title} · {session.durationMin} min</p>
            <ol className="list-decimal space-y-1 pl-5 text-xs text-muted-foreground">
              {session.agenda.map((a, i) => <li key={i}>{a}</li>)}
            </ol>
            <p className="rounded bg-muted/40 px-2 py-1 text-xs italic">Invite: “{session.inviteLine}”</p>
            {listingId && session.moment !== "buyer_kickoff" && (
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  value={floor}
                  onChange={(e) => { setFloor(e.target.value); setFloorSaved(false) }}
                  placeholder="Seller's walk-away floor ($)"
                  className="h-7 w-52 rounded-md border bg-background px-2 text-xs"
                />
                <Button size="sm" variant="outline" className="h-7 text-xs" disabled={pending || !floor}
                  onClick={() => startTransition(async () => {
                    const r = await setSellerFloorAction({ listingId, floor: Number(floor) })
                    if (r.ok) setFloorSaved(true); else setError(r.error)
                  })}>
                  {floorSaved ? "Floor set" : "Set the floor"}
                </Button>
                <span className="text-[11px] text-muted-foreground">Decided calmly now — honored under offer pressure later.</span>
              </div>
            )}
            <div className="flex items-center gap-2">
              <Button size="sm" className="h-7 text-xs" onClick={schedule} disabled={pending || scheduled}>
                {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : scheduled ? <Check className="h-3 w-3" /> : null}
                {scheduled ? "Task created" : "Create the session task"}
              </Button>
              {session.agentPrep[0] && <p className="text-[11px] text-muted-foreground">{session.agentPrep[0]}</p>}
            </div>
          </>
        )}
        {error && <p className="text-xs text-red-600">{error}</p>}
      </CardContent>
    </Card>
  )
}
