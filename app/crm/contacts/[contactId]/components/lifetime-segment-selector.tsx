"use client"

/**
 * LIFETIME SEGMENT — the staff control for the column the lifetime portal reads.
 *
 * setLifetimeSegment is the ONLY writer of contacts.lifetime_segment (staff-only:
 * the action refuses a contact acting on themselves), and the portal's card plan
 * (lifetimeCardPlan) branches entirely on that column — 'relocated' swaps the
 * local-owner cards for the from-afar set and generates the relocated welcome
 * ONCE through the brand-voice gateway. Until this selector, no surface called
 * it, so every past client rendered as 'local_owner' forever.
 */

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { setLifetimeSegment } from "@/app/actions/portal-lifetime"
import type { LifetimeSegment } from "@/lib/portal/lifetime-segment"
import { Loader2 } from "lucide-react"
import { cn } from "@/lib/utils"

const SEGMENTS: Array<{ value: LifetimeSegment; label: string; hint: string }> = [
  { value: "local_owner", label: "Local owner", hint: "still owns in our market — home value, equity and local cards" },
  { value: "relocated",   label: "Relocated",   hint: "moved out of market — referral-out and stay-in-touch cards" },
]

export function LifetimeSegmentSelector({ contactId, initialSegment }: {
  contactId: string
  initialSegment: LifetimeSegment
}) {
  const router = useRouter()
  const [segment, setSegment] = useState<LifetimeSegment>(initialSegment)
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  const change = (next: LifetimeSegment) => {
    if (next === segment || isPending) return
    setError(null)
    startTransition(async () => {
      const res = await setLifetimeSegment({ contactId, segment: next })
      if (!res.ok) { setError(res.error ?? "Segment was not changed"); return }
      setSegment(next)
      router.refresh()
    })
  }

  return (
    <div className="col-span-2 pt-1">
      <p className="text-xs text-muted-foreground mb-1">
        Lifetime portal segment — controls which cards their portal shows
      </p>
      <div className="flex items-center gap-1.5 flex-wrap">
        {SEGMENTS.map((s) => (
          <button key={s.value} type="button" title={s.hint} onClick={() => change(s.value)} disabled={isPending}
            className={cn(
              "rounded-full border px-2.5 py-0.5 text-xs transition-colors",
              segment === s.value ? "border-primary bg-primary/10 font-medium" : "hover:border-primary/50",
            )}>
            {s.label}
          </button>
        ))}
        {isPending && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
      </div>
      {error && <p className="text-xs text-destructive mt-1">{error}</p>}
    </div>
  )
}
