"use client"

/**
 * app/crm/contacts/[contactId]/components/followup-card.tsx
 *
 * "Call me in six months."
 *
 * The reactivation runners have always CHECKED for a stated future re-contact
 * date — lib/lead-pipeline/reactivation-enroller.ts runs
 * followupSuppresses(contact.next_followup_at, now) before enrolling anyone in
 * a nurture cadence — but nothing in the product could SET one:
 * lib/lead-pipeline/schedule-followup.ts:setEntityFollowup, the only writer of
 * that column outside the demo seed, had no caller. So a contact who asked to
 * be left alone until the spring kept getting the drip.
 *
 * This is the agent-facing entry point. The write goes through
 * app/actions/crm.ts:scheduleContactFollowup, which proves the contact is in
 * the caller's brokerage before setEntityFollowup (service client, RLS
 * bypassed) is allowed to touch it.
 */

import { useState, useTransition } from "react"
import { CalendarClock, Loader2 } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { scheduleContactFollowup } from "@/app/actions/crm"

function toDateInputValue(iso: string | null): string {
  if (!iso) return ""
  const d = new Date(iso)
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : ""
}

export function FollowupCard({
  contactId,
  initialFollowupAt,
  initialReason,
}: {
  contactId: string
  initialFollowupAt: string | null
  initialReason: string | null
}) {
  const [date, setDate] = useState(() => toDateInputValue(initialFollowupAt))
  const [reason, setReason] = useState(initialReason ?? "")
  const [savedAt, setSavedAt] = useState<string | null>(initialFollowupAt)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const [isPending, startTransition] = useTransition()

  function save() {
    if (!date) {
      setMessage({ ok: false, text: "Pick a date first." })
      return
    }
    startTransition(async () => {
      setMessage(null)
      // A date input yields YYYY-MM-DD; the action takes an ISO timestamp and
      // rejects anything Date cannot parse.
      const at = new Date(`${date}T09:00:00`).toISOString()
      const result = await scheduleContactFollowup({
        contactId,
        at,
        reason: reason.trim() || null,
      })
      if (!result.success) {
        setMessage({ ok: false, text: result.error ?? "Follow-up not saved." })
        return
      }
      setSavedAt(at)
      setMessage({ ok: true, text: "Saved — nurture cadences will hold off until then." })
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <CalendarClock className="h-4 w-4" />
          Next follow-up
        </CardTitle>
        <CardDescription>
          A stated future timeline. Reactivation cadences honour this date and stay quiet until it
          arrives — this is not a reminder, it is a suppression.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {savedAt && (
          <p className="text-sm text-muted-foreground">
            Currently held until <strong>{new Date(savedAt).toLocaleDateString()}</strong>
            {initialReason ? ` — “${initialReason}”` : ""}
          </p>
        )}
        <div className="grid gap-3 sm:grid-cols-[12rem_1fr]">
          <div className="space-y-1.5">
            <Label htmlFor="followup-date">Reach out on</Label>
            <Input
              id="followup-date"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="followup-reason">What they said</Label>
            <Input
              id="followup-reason"
              placeholder="Calling after the school year"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" onClick={save} disabled={isPending}>
            {isPending ? <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" /> : null}
            Save follow-up date
          </Button>
          {message && (
            <span className={message.ok ? "text-sm text-muted-foreground" : "text-sm text-destructive"}>
              {message.text}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
