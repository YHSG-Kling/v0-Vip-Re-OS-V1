"use client"

/**
 * The one control on the compliance queue that CLOSES a loop.
 *
 * The queue used to be read-only over a ledger nothing could ever close, so
 * every flag ever raised sat there forever. A TC who chased the missing document
 * and watched it land had no way to say so.
 *
 * This clears one flag by its stable key (see
 * lib/compliance/offer-flag-resolution.ts for what that key is and why), through
 * `resolveComplianceFlagAction`, which re-checks the caller's role and tenant
 * server-side — the button being visible is never the authorization.
 *
 * It is NOT a way past the audit gate: `submitOfferToCompliance` recomputes the
 * required-documents audit and the packet scan on every attempt and never reads
 * this ledger. A flag cleared without the fix simply comes back on the next
 * submit.
 */

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Check, Loader2 } from "lucide-react"
import { resolveComplianceFlagAction } from "@/app/actions/compliance/dashboard"

export function FlagRowActions({
  offerId,
  flagKey,
  flagTitle,
}: {
  offerId: string
  flagKey: string
  flagTitle: string
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [cleared, setCleared] = useState(false)

  function clear() {
    setError(null)
    startTransition(async () => {
      const r = await resolveComplianceFlagAction({
        offerId,
        flagKey,
        note: `Marked satisfied from the compliance queue: ${flagTitle}`,
      })
      if (!r.success) {
        setError(r.error ?? "Could not clear this flag.")
        return
      }
      if (r.resolved_count === 0) {
        // A successful call that changed nothing is not success to a human — the
        // flag was already cleared by someone else or by a passing submit.
        setError("Nothing to clear — this flag was already closed. Refreshing.")
      }
      setCleared(true)
      router.refresh()
    })
  }

  if (cleared && !error) {
    return (
      <span className="text-xs text-emerald-700 inline-flex items-center gap-1 whitespace-nowrap">
        <Check className="h-3 w-3" />
        Cleared
      </span>
    )
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        size="sm"
        variant="outline"
        className="h-7 px-2 text-xs"
        onClick={clear}
        disabled={pending}
      >
        {pending
          ? <Loader2 className="h-3 w-3 mr-1 animate-spin" />
          : <Check className="h-3 w-3 mr-1" />}
        {pending ? "Clearing…" : "Mark satisfied"}
      </Button>
      {error && <p className="text-xs text-red-600 max-w-[16rem] text-right">{error}</p>}
    </div>
  )
}
