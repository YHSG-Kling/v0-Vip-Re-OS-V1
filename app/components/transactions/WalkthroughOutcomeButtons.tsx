"use client"

/**
 * WALKTHROUGH OUTCOME buttons (forgotten-items #38) — one tap after the
 * final walkthrough: all good / minor issues / major issues. Each branch
 * runs a DIFFERENT process (closing logistics / punch list / same-day
 * huddle + the deal auto-flags shaky). The client line ships in the task.
 */

import { useState, useTransition } from "react"
import { ClipboardCheck, Loader2 } from "lucide-react"
import { setWalkthroughOutcomeAction } from "@/app/actions/walkthrough-outcome"
import type { WalkthroughOutcome } from "@/lib/transactions/walkthrough-outcome"

const OPTIONS: Array<{ key: WalkthroughOutcome; label: string; tone: string }> = [
  { key: "all_good", label: "All good", tone: "hover:bg-emerald-50 data-[done=true]:border-emerald-400 data-[done=true]:bg-emerald-50" },
  { key: "minor_issues", label: "Minor issues", tone: "hover:bg-amber-50 data-[done=true]:border-amber-400 data-[done=true]:bg-amber-50" },
  { key: "major_issues", label: "Major issues", tone: "hover:bg-red-50 data-[done=true]:border-red-400 data-[done=true]:bg-red-50" },
]

export function WalkthroughOutcomeButtons({ transactionId }: { transactionId: string }) {
  const [recorded, setRecorded] = useState<WalkthroughOutcome | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const record = (outcome: WalkthroughOutcome) => {
    startTransition(async () => {
      const r = await setWalkthroughOutcomeAction({ transactionId, outcome })
      if (r.ok) {
        setRecorded(outcome)
        setNote(`${r.tasksCreated} follow-up task${r.tasksCreated === 1 ? "" : "s"} created${r.flaggedShaky ? " · deal flagged shaky (AI on manual)" : ""}.`)
      } else {
        setNote(r.error)
      }
    })
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
        <ClipboardCheck className="h-3 w-3" /> Walkthrough:
      </span>
      {OPTIONS.map((o) => (
        <button
          key={o.key}
          data-done={recorded === o.key}
          onClick={() => record(o.key)}
          disabled={pending || recorded !== null}
          className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors disabled:opacity-70 ${o.tone}`}
        >
          {pending && recorded === null ? <Loader2 className="inline h-3 w-3 animate-spin" /> : o.label}
        </button>
      ))}
      {note && <span className="text-[11px] text-muted-foreground">{note}</span>}
    </div>
  )
}
