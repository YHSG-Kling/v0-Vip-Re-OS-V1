"use client"

// SavedSearchControls — the buyer's OWN cadence + snooze controls on each saved search. RealScout's
// wishlist (and our doc) asks for exactly this: "daily digests vs. instant alerts, plus snooze …
// without turning off the search." Cadence is already enforced by the alert engine (shouldRunNow);
// snooze is a temporary, AUTO-RESUMING mute (snoozed_until) so the buyer never has to remember to
// turn a search back on. This REDUCES noise — the rare feature that earns trust instead of spending it.

import { useState, useTransition } from "react"
import { Bell, BellOff, Clock, Zap } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useToast } from "@/hooks/use-toast"
import { buyerAdjustAlert } from "@/app/actions/property-alerts/alert-actions"

const CADENCES: { value: string; label: string; icon: any }[] = [
  { value: "instant", label: "Instant", icon: Zap },
  { value: "daily", label: "Daily", icon: Clock },
  { value: "weekly", label: "Weekly", icon: Clock },
]

function snoozeLabel(snoozedUntil: string | null): string | null {
  if (!snoozedUntil) return null
  const t = new Date(snoozedUntil).getTime()
  if (!Number.isFinite(t) || t <= Date.now()) return null
  const days = Math.max(1, Math.ceil((t - Date.now()) / 86_400_000))
  return `Snoozed ${days}d`
}

export function SavedSearchControls({
  alertId, contactId, frequency, isActive, snoozedUntil,
}: {
  alertId: string
  contactId: string
  frequency: string | null
  isActive: boolean
  snoozedUntil: string | null
}) {
  const { toast } = useToast()
  const [isPending, startTransition] = useTransition()
  const [freq, setFreq] = useState(frequency ?? "daily")
  const [snoozedTo, setSnoozedTo] = useState<string | null>(snoozedUntil)

  const snoozed = snoozeLabel(snoozedTo)

  function setCadence(next: string) {
    if (next === freq) return
    const prev = freq
    setFreq(next)
    startTransition(async () => {
      const r = await buyerAdjustAlert(alertId, contactId, { frequency: next })
      if (r.success) toast({ title: `Alerts set to ${next}` })
      else { setFreq(prev); toast({ title: r.error ?? "Couldn't update", variant: "destructive" }) }
    })
  }

  function snooze(days: number | null) {
    startTransition(async () => {
      const r = await buyerAdjustAlert(alertId, contactId, { snooze_days: days })
      if (r.success) {
        setSnoozedTo(days && days > 0 ? new Date(Date.now() + days * 86_400_000).toISOString() : null)
        toast({ title: days ? `Snoozed for ${days} days — it'll resume on its own` : "Resumed" })
      } else {
        toast({ title: r.error ?? "Couldn't update", variant: "destructive" })
      }
    })
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex items-center gap-2">
        {snoozed && <Badge variant="secondary" className="text-amber-700 bg-amber-50">{snoozed}</Badge>}
        <Badge variant={isActive ? "default" : "secondary"}>{isActive ? "Active" : "Paused"}</Badge>
      </div>

      {/* Cadence */}
      <div className="flex items-center gap-1">
        {CADENCES.map(({ value, label, icon: Icon }) => (
          <button
            key={value}
            type="button"
            disabled={isPending}
            onClick={() => setCadence(value)}
            className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition ${
              freq === value ? "border-teal-600 bg-teal-50 text-teal-700" : "border-border text-muted-foreground hover:border-teal-300"
            }`}
          >
            <Icon className="h-3 w-3" /> {label}
          </button>
        ))}
      </div>

      {/* Snooze */}
      <div className="flex items-center gap-1">
        {snoozed ? (
          <Button size="sm" variant="ghost" className="h-7 text-xs gap-1" disabled={isPending} onClick={() => snooze(null)}>
            <Bell className="h-3 w-3" /> Resume now
          </Button>
        ) : (
          <>
            <span className="text-[11px] text-muted-foreground flex items-center gap-1"><BellOff className="h-3 w-3" /> Snooze</span>
            {[7, 30].map((d) => (
              <button key={d} type="button" disabled={isPending} onClick={() => snooze(d)}
                className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:border-amber-300 hover:text-amber-700">
                {d}d
              </button>
            ))}
          </>
        )}
      </div>
    </div>
  )
}
