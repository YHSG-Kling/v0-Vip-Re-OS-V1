"use client"

/**
 * Disposition controls for a ranked income-gap recommendation.
 *
 * Wave 4 slice 2: `app/actions/income-engine.ts` has three actions the
 * income-truth page uses — compute, read, and… nothing. Both
 * `completeRecommendedActionAction` and `dismissRecommendedActionAction` had no
 * caller anywhere, so `income_gap_recommended_actions.status` could only ever be
 * the `open` the generator writes. The queue was purely advisory: an agent who
 * had actually done the work had no way to say so, the same recommendation came
 * back every week, and the `completed_outcome` column the module's own header
 * describes as "records outcome for future tuning" was never written by anyone.
 *
 * Status values are live-verified against
 * `income_gap_recommended_actions_status_check`
 * (open | in_progress | completed | dismissed | expired).
 */

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Check, X, Loader2 } from "lucide-react"
import {
  completeRecommendedActionAction,
  dismissRecommendedActionAction,
} from "@/app/actions/income-engine"

export function ActionDisposition({ actionId }: { actionId: string }) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<"completed" | "dismissed" | null>(null)
  const [isPending, startTransition] = useTransition()

  function run(kind: "completed" | "dismissed") {
    setError(null)
    startTransition(async () => {
      const r =
        kind === "completed"
          ? await completeRecommendedActionAction({ actionId }).catch(() => ({
              ok: false,
              error: "Could not reach the server",
            }))
          : await dismissRecommendedActionAction({ actionId }).catch(() => ({
              ok: false,
              error: "Could not reach the server",
            }))
      if (!r.ok) {
        // The actions now refuse a zero-row update instead of reporting
        // success, so this message means the write really did not land.
        setError(r.error ?? "Could not update that recommendation")
        return
      }
      setDone(kind)
      router.refresh()
    })
  }

  if (done) {
    return (
      <span className="text-xs text-muted-foreground shrink-0">
        {done === "completed" ? "Marked done" : "Dismissed"}
      </span>
    )
  }

  return (
    <div className="flex flex-col items-end gap-1 shrink-0">
      <div className="flex gap-1">
        <Button
          size="sm"
          variant="outline"
          className="h-7 px-2 text-xs"
          onClick={() => run("completed")}
          disabled={isPending}
        >
          {isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3 mr-1" />}
          Done
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-xs text-muted-foreground"
          onClick={() => run("dismissed")}
          disabled={isPending}
          aria-label="Dismiss this recommendation"
        >
          <X className="h-3 w-3" />
        </Button>
      </div>
      {error && <p className="text-[11px] text-red-600 max-w-[16rem] text-right">{error}</p>}
    </div>
  )
}
