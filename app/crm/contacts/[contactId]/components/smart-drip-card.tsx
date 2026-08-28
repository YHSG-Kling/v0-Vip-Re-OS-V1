"use client"

/**
 * app/crm/contacts/[contactId]/components/smart-drip-card.tsx
 *
 * The agent-facing door for startSmartDrip (restored lane F1 2026-08-28).
 *
 * A "smart drip" is an enrollment, not a message: the contact is handed to the
 * brokerage's active, compliance-gated campaign_sequences row of the chosen
 * type, whose STEPS carry the real content (executed by the
 * campaign-sequence-steps cron). The action refuses honestly when no such
 * sequence exists — nothing is invented, and nothing is silently queued into
 * a cadence that cannot send.
 */

import { useState, useTransition } from "react"
import { Droplets, Loader2 } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { startSmartDrip } from "@/app/actions/workflows"

/** The cadence kinds an agent starts by hand — sequence_type spellings the
 *  drip drain can match (transaction/post_close are event-driven, not doors). */
const DRIP_TYPES: { value: string; label: string; hint: string }[] = [
  { value: "drip",          label: "Drip",          hint: "Fast follow-up cadence" },
  { value: "nurture",       label: "Nurture",       hint: "Long-term relationship cadence" },
  { value: "re_engagement", label: "Re-engagement", hint: "Reactivate a gone-quiet contact" },
]

export function SmartDripCard({ contactId }: { contactId: string }) {
  const [dripType, setDripType] = useState<string>("nurture")
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const [isPending, startTransition] = useTransition()

  function start() {
    startTransition(async () => {
      setMessage(null)
      const result = await startSmartDrip(contactId, dripType)
      if (!result.success) {
        setMessage({ ok: false, text: result.error ?? "The drip was not started." })
        return
      }
      setMessage({
        ok: true,
        text: result.alreadyEnrolled
          ? `Already enrolled in “${result.sequenceName ?? dripType}” — not double-enrolled.`
          : `Enrolled in “${result.sequenceName ?? dripType}” — the sequence steps take it from here.`,
      })
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Droplets className="h-4 w-4" />
          Smart drip
        </CardTitle>
        <CardDescription>
          Enrolls this contact into your active, compliance-gated sequence of the chosen
          type. The sequence&apos;s steps carry the messages — if no sequence of that type
          exists yet, nothing is sent and you&apos;ll be told so.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-[16rem_auto] sm:items-end">
          <div className="space-y-1.5">
            <Label>Cadence</Label>
            <Select value={dripType} onValueChange={setDripType}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DRIP_TYPES.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label} — {t.hint}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button size="sm" onClick={start} disabled={isPending}>
            {isPending ? <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" /> : null}
            Start drip
          </Button>
        </div>
        {message && (
          <p className={message.ok ? "text-sm text-muted-foreground" : "text-sm text-destructive"}>
            {message.text}
          </p>
        )}
      </CardContent>
    </Card>
  )
}
