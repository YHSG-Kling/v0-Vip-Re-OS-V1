"use client"

// app/dashboard/admin/billing/seat-door-card.tsx
// ─────────────────────────────────────────────────────────────────────────────
// THE SEAT DOOR's tenant-facing surface (wave 79 integration). Lane 79A built
// the door — getSeatDoorAction / buySeatPackagesAction / changePlanTierAction
// in app/actions/billing.ts, the paths computed by seatDecision in
// lib/kernel/tier-role-matrix.ts — but mounted no page, so no-orphan-actions /
// wired-surface flagged three actions imported by nothing. OWNER (2026-09-23):
// "if the tenant hits a limit they will be able to either upgrade to a higher
// tier (or lower tier if their business changes) or buy more seats." Every
// button here is one of those three paths, offered ONLY when the door offers
// it (a package is never sold unpriced; a downgrade only when today's
// producers fit). Stripe is written first; the row follows.
import { useEffect, useState, useTransition } from "react"
import { Button } from "@/components/ui/button"
import { useToast } from "@/hooks/use-toast"
import {
  buySeatPackagesAction,
  changePlanTierAction,
  getSeatDoorAction,
  type SeatDoor,
} from "@/app/actions/billing"

export function SeatDoorCard() {
  const [door, setDoor] = useState<SeatDoor | null>(null)
  const [pending, start] = useTransition()
  const { toast } = useToast()

  const load = () => getSeatDoorAction().then(setDoor).catch((e) => setDoor({ ok: false, error: e instanceof Error ? e.message : "Could not read the seat door", tier: null, seatCount: null, decision: null, message: null, paths: [] }))
  useEffect(() => { void load() }, [])

  function act(fn: () => Promise<{ ok: boolean; error?: string }>, done: string) {
    start(async () => {
      const r = await fn()
      if (r.ok) { toast({ title: done }); await load() }
      else toast({ title: "Not applied", description: r.error ?? "The change was refused", variant: "destructive" })
    })
  }

  if (!door) return null
  if (!door.ok) return <section className="rounded-lg border p-4 text-xs text-destructive">{door.error ?? "Seat door unavailable"}</section>

  const d = door.decision
  return (
    <section className="rounded-lg border p-4 space-y-3">
      <div>
        <h2 className="text-sm font-semibold">Producer seats</h2>
        <p className="text-xs text-muted-foreground">
          {door.seatCount ?? 0} producer{door.seatCount === 1 ? "" : "s"} seated on the {door.tier ?? "current"} plan
          {d ? ` · band ${d.bandLimit ?? "custom"}${d.extraSeats ? ` + ${d.extraSeats} purchased` : ""}${d.remaining !== null ? ` · ${d.remaining} remaining` : ""}` : ""}.
          Staff and non-producing brokers never take a seat.
        </p>
        {door.message && <p className="text-xs mt-1">{door.message}</p>}
      </div>
      {door.paths.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {door.paths.map((p, i) => {
            if (p.kind === "upgrade") return (
              <Button key={i} size="sm" variant="outline" disabled={pending} onClick={() => act(() => changePlanTierAction(p.tier), `Moved up to ${p.tier}`)}>
                Upgrade to {p.tier}{p.seats !== null ? ` (${p.seats} seats)` : " (custom seats)"}
              </Button>
            )
            if (p.kind === "downgrade") return (
              <Button key={i} size="sm" variant="outline" disabled={pending} onClick={() => act(() => changePlanTierAction(p.tier), `Moved down to ${p.tier}`)}>
                Downgrade to {p.tier}{p.seats !== null ? ` (${p.seats} seats)` : ""}
              </Button>
            )
            if (p.kind === "buy_seats") return (
              <Button key={i} size="sm" disabled={pending} onClick={() => act(() => buySeatPackagesAction(p.packages), `Added ${p.seatsAdded} seats`)}>
                Buy {p.packages} seat package{p.packages === 1 ? "" : "s"} ({p.seatsAdded} seats · ${(p.priceCents / 100).toFixed(0)}/mo each)
              </Button>
            )
            return <span key={i} className="text-xs text-muted-foreground self-center">Contact us for custom seating</span>
          })}
        </div>
      )}
    </section>
  )
}
