"use client"

/**
 * MILESTONE DEADLINES → CALENDAR.
 *
 * `app/actions/ai-calendar-management.ts:createDeadlineEventsFromMilestones` turns
 * every pending transaction_milestone that has a target_date into a
 * system-generated `deadline` calendar event, idempotently (one event per
 * milestone). Its own docblock says "called when a transaction is created or
 * updated" — and it was called from nowhere at all, so the dates the Watchtower
 * above computes a critical path from had never once reached anybody's calendar.
 *
 * Deliberately a BUTTON and not an automatic effect on render: this writes rows,
 * and a write that fires because someone opened a page is a write nobody asked
 * for. The action is idempotent, so pressing it twice is safe.
 *
 * The result is reported exactly as the action returns it — created, already
 * present, and any milestone whose event was REFUSED. A run that wrote nothing
 * because every insert was rejected must not read the same as a run that found
 * everything already scheduled.
 */

import { useState, useTransition } from "react"
import { Button } from "@/components/ui/button"
import { CalendarPlus, Loader2 } from "lucide-react"
import { createDeadlineEventsFromMilestones } from "@/app/actions/ai-calendar-management"

export function MilestoneDeadlinesButton({ transactionId }: { transactionId: string }) {
  const [result, setResult] = useState<
    { created: number; skipped: number; failures: string[] } | null
  >(null)
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  const run = () => {
    setError(null)
    setResult(null)
    startTransition(async () => {
      const res = await createDeadlineEventsFromMilestones({ transactionId })
      if (!res.success) {
        setError((res as { error?: string }).error ?? "Could not add these deadlines.")
        return
      }
      setResult({
        created: (res as any).created ?? 0,
        skipped: (res as any).skipped ?? 0,
        failures: ((res as any).failures ?? []) as string[],
      })
    })
  }

  return (
    <div className="mt-2">
      <Button size="sm" variant="outline" className="h-7 text-xs" onClick={run} disabled={isPending}>
        {isPending ? (
          <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
        ) : (
          <CalendarPlus className="mr-1.5 h-3 w-3" />
        )}
        Add deadlines to calendar
      </Button>

      {error && <p className="mt-1.5 text-xs text-destructive">{error}</p>}

      {result && (
        <div className="mt-1.5 text-xs">
          <p className="text-muted-foreground">
            {result.created} added
            {result.skipped > 0 && ` · ${result.skipped} already on the calendar`}
            {result.created === 0 && result.skipped === 0 && result.failures.length === 0 &&
              " — no pending milestone on this deal has a target date yet"}
          </p>
          {result.failures.length > 0 && (
            <ul className="mt-1 ml-4 list-disc text-destructive">
              {result.failures.map((f, i) => (
                <li key={i}>{f}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
