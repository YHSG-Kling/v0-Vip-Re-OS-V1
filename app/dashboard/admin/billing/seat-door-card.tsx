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
//
// WAVE 81A — the MANAGING BROKER block (owner: "there can only be one managing
// broker per brokerage location" … "has to be producing"): one select per
// office (a single-office tenant sees its principal office), the licensed row
// of a managing broker reads "managing broker · <office>" and loses the
// non-producing toggle (the writer refuses it anyway; the card does not offer
// a button that can only fail).
import { useEffect, useState, useTransition } from "react"
import { Button } from "@/components/ui/button"
import { useToast } from "@/hooks/use-toast"
import {
  buySeatPackagesAction,
  changePlanTierAction,
  getSeatDoorAction,
  setLicensedProducerAction,
  type SeatDoor,
} from "@/app/actions/billing"
import { listManagingBrokerSlotsAction, setManagingBrokerAction } from "@/app/actions/managing-broker"
import type { ManagingBrokerRoster } from "@/lib/kernel/managing-broker"

export function SeatDoorCard() {
  const [door, setDoor] = useState<SeatDoor | null>(null)
  const [offices, setOffices] = useState<ManagingBrokerRoster | null>(null)
  const [pending, start] = useTransition()
  const { toast } = useToast()

  const load = async () => {
    await Promise.all([
      getSeatDoorAction().then(setDoor).catch((e) => setDoor({ ok: false, error: e instanceof Error ? e.message : "Could not read the seat door", tier: null, seatCount: null, decision: null, message: null, paths: [], licensed: [] })),
      listManagingBrokerSlotsAction().then(setOffices).catch((e) => setOffices({ ok: false, error: e instanceof Error ? e.message : "Could not read the offices", slots: [], eligible: [] })),
    ])
  }
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
          Agents, team leads, brokers and broker owners are producer seats; staff never take one.
          A broker who runs the shop and does not sell can be marked non-producing below — except an office&apos;s managing broker, who manages that office&apos;s agents and always holds a producing seat.
        </p>
        {door.message && <p className="text-xs mt-1">{door.message}</p>}
      </div>
      {door.licensed.length > 0 && (
        <div className="space-y-1">
          <h3 className="text-xs font-medium">Licensed brokers</h3>
          <ul className="space-y-1">
            {door.licensed.map((p) => (
              <li key={p.userId} className="flex items-center justify-between gap-2 text-xs">
                <span>
                  {p.label} <span className="text-muted-foreground">({p.role.replace("_", " ")})</span>
                  {" — "}
                  {p.managingBrokerOf.length > 0
                    ? <span className="font-medium">managing broker · {p.managingBrokerOf.join(", ")} (seat)</span>
                    : p.producing ? "producing (seat)" : "non-producing (free)"}
                </span>
                {p.managingBrokerOf.length === 0 && (
                  <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" disabled={pending}
                    onClick={() => act(() => setLicensedProducerAction(p.userId, !p.producing), p.producing ? `${p.label} marked non-producing` : `${p.label} marked producing`)}>
                    {p.producing ? "Mark non-producing" : "Mark producing"}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {offices && (
        <div className="space-y-1">
          <h3 className="text-xs font-medium">Managing broker per office</h3>
          {!offices.ok && <p className="text-xs text-destructive">{offices.error ?? "Offices unavailable"}</p>}
          {offices.ok && offices.eligible.length === 0 && (
            <p className="text-xs text-muted-foreground">No broker or broker owner is seated yet — invite one to name an office&apos;s managing broker.</p>
          )}
          {offices.ok && (
            <ul className="space-y-1">
              {offices.slots.map((s) => (
                <li key={s.locationId ?? "principal"} className="flex items-center justify-between gap-2 text-xs">
                  <span>
                    {s.locationName}
                    {s.locationId === null && <span className="text-muted-foreground"> (principal office)</span>}
                    {" — "}
                    {s.managingBrokerLabel ? <span>{s.managingBrokerLabel}{s.assignedAt ? <span className="text-muted-foreground"> · since {s.assignedAt.slice(0, 10)}{s.assignedBy ? " (assigned by an admin)" : ""}</span> : null}</span> : <span className="text-amber-700">no managing broker assigned</span>}
                  </span>
                  <select
                    className="h-6 rounded border bg-background px-1 text-xs"
                    disabled={pending || offices.eligible.length === 0}
                    value={s.managingBrokerUserId ?? ""}
                    onChange={(e) => {
                      const userId = e.target.value || null
                      act(() => setManagingBrokerAction({ locationId: s.locationId, userId }), userId ? `Managing broker set for ${s.locationName}` : `Managing broker cleared for ${s.locationName}`)
                    }}
                  >
                    <option value="">— none —</option>
                    {offices.eligible.map((p) => <option key={p.userId} value={p.userId}>{p.label} ({p.role.replace("_", " ")})</option>)}
                  </select>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
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
