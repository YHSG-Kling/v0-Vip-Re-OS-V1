"use client"

// Lane 86H — the brokerage's review-request timing, beside the review-request flow it paces.
// brokerage_settings.review_request_delay_days was read by the daily review-request cron and
// written by nobody, so every brokerage asked for reviews on the hard-coded day 5. Tenant
// admins only: /referrals renders this card only when getReviewRequestDelaySettingAction
// passed its gate, and the save re-runs that gate server-side (the card is not the boundary).
import { useState, useTransition } from "react"
import { CalendarClock, Check, Loader2, RotateCcw } from "lucide-react"
import { toast } from "sonner"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { saveReviewRequestDelayAction } from "@/app/actions/settings/brokerage-column-settings"

export interface ReviewRequestTimingInitial {
  canEdit: boolean
  storedDays: number | null
  effectiveDays: number
  defaultDays: number
  minDays: number
  maxDays: number
  lookbackDays: number
}

export function ReviewRequestTimingCard({ initial }: { initial: ReviewRequestTimingInitial }) {
  const [stored, setStored] = useState<number | null>(initial.storedDays)
  const [effective, setEffective] = useState(initial.effectiveDays)
  const [draft, setDraft] = useState(String(initial.effectiveDays))
  const [pending, startTransition] = useTransition()

  const parsed = Number(draft)
  const inRange = draft.trim() !== "" && Number.isInteger(parsed) && parsed >= initial.minDays && parsed <= initial.maxDays

  const save = (days: number | null) =>
    startTransition(async () => {
      const r = await saveReviewRequestDelayAction(days)
      if (!r.ok) {
        toast.error(r.error)
        return
      }
      setStored(r.storedDays)
      setEffective(r.effectiveDays)
      setDraft(String(r.effectiveDays))
      toast.success(r.storedDays === null ? `Review requests reset to the default (${initial.defaultDays} days)` : `Review requests go out ${r.effectiveDays} days after closing`)
    })

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <CalendarClock className="h-4 w-4 text-primary" />
          Automatic review request timing
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          How many days after a closing the brokerage automatically emails the client for a review.
          Currently <strong>{effective} days</strong>
          {stored === null ? ` (the default)` : ""}.
        </p>
      </CardHeader>
      <CardContent className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <Label htmlFor="review-request-delay" className="text-xs">
            Days after closing ({initial.minDays}–{initial.maxDays})
          </Label>
          <Input
            id="review-request-delay"
            className="h-8 w-24 text-xs"
            type="number"
            inputMode="numeric"
            min={initial.minDays}
            max={initial.maxDays}
            step={1}
            value={draft}
            disabled={!initial.canEdit || pending}
            onChange={(e) => setDraft(e.target.value)}
          />
        </div>
        <Button size="sm" disabled={!initial.canEdit || pending || !inRange} onClick={() => save(parsed)}>
          {pending ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Check className="h-3.5 w-3.5 mr-1" />}
          Save
        </Button>
        <Button size="sm" variant="outline" disabled={!initial.canEdit || pending || stored === null} onClick={() => save(null)}>
          <RotateCcw className="h-3.5 w-3.5 mr-1" />
          Use default ({initial.defaultDays})
        </Button>
        {!inRange && draft.trim() !== "" && (
          <p className="w-full text-xs text-destructive">
            Enter a whole number from {initial.minDays} to {initial.maxDays}. The daily run only looks at closings from
            the last {initial.lookbackDays} days, and the limit keeps a week of runs inside that window.
          </p>
        )}
        {!initial.canEdit && (
          <p className="w-full text-xs text-muted-foreground">Read-only access — switch to full access to change this.</p>
        )}
      </CardContent>
    </Card>
  )
}
