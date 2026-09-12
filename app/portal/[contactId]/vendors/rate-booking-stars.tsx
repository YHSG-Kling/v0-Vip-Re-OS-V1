"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/app/components/ui/button"
import { Star, Loader2 } from "lucide-react"
import { rateVendorBookingAsClient } from "@/app/actions/contact-vendor-booking"

interface Props {
  contactId: string
  bookingId: string
}

/**
 * The client's 1-5 star control on a COMPLETED, not-yet-rated booking row —
 * the door the vendor-loop review request points its deep link at. Mirrors the
 * agent-side widget style in
 * app/components/transactions/VendorBookingSection.tsx (tap a star, submit).
 * The server action re-checks everything (self-gate, completed, unrated), so
 * this component is convenience, not enforcement.
 */
export function RateBookingStars({ contactId, bookingId }: Props) {
  const router = useRouter()
  const [value, setValue] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const [isPending, startTransition] = useTransition()

  function submit() {
    if (value < 1) return
    setError(null)
    startTransition(async () => {
      const res = await rateVendorBookingAsClient({ contactId, bookingId, rating: value })
      if (res.success) {
        setDone(true)
        router.refresh()
      } else {
        setError(res.error ?? "Could not save your rating")
      }
    })
  }

  if (done) {
    return <p className="text-xs text-green-700">Thanks — your rating was recorded.</p>
  }

  return (
    <div className="space-y-2 bg-muted/30 p-2 rounded-md">
      <p className="text-xs text-muted-foreground">How did this service go?</p>
      <div className="flex items-center gap-1">
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} type="button" aria-label={`${n} star${n === 1 ? "" : "s"}`} onClick={() => setValue(n)}>
            <Star className={`h-4 w-4 ${n <= value ? "fill-yellow-400 text-yellow-400" : "text-muted-foreground"}`} />
          </button>
        ))}
      </div>
      <Button size="sm" className="h-7 text-xs" onClick={submit} disabled={isPending || value < 1}>
        {isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : "Submit Rating"}
      </Button>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}
