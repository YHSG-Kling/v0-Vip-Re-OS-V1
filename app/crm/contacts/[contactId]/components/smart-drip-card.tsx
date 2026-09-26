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

import { useCallback, useEffect, useState, useTransition } from "react"
import { Droplets, Loader2 } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { listContactDrips, startSmartDrip, type ContactDripRow } from "@/app/actions/workflows"

/** The cadence kinds an agent starts by hand — sequence_type spellings the
 *  drip drain can match (transaction/post_close are event-driven, not doors). */
const DRIP_TYPES: { value: string; label: string; hint: string }[] = [
  { value: "drip",          label: "Drip",          hint: "Fast follow-up cadence" },
  { value: "nurture",       label: "Nurture",       hint: "Long-term relationship cadence" },
  { value: "re_engagement", label: "Re-engagement", hint: "Reactivate a gone-quiet contact" },
]

/** Short, human date — the lifecycle stamps are timestamps, not prose. */
function when(iso: string | null): string {
  if (!iso) return ""
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString()
}

/**
 * ORPHAN DOCTRINE §1.2 — BUILD THE MISSING HALF.
 *
 * One line per past drip, reading the lifecycle stamps that had no reader:
 * started_at / completed_at / paused_at / agent_id (via `startedByMe`). The
 * PAUSED line is the one that matters: the queue drain pauses a drip when the
 * brokerage has no active compliance-gated sequence of that type, and until
 * this list existed that reason died in a metadata column nobody opened.
 */
function DripHistoryLine({ drip }: { drip: ContactDripRow }) {
  const stamp =
    drip.status === "completed" ? when(drip.completedAt)
    : drip.status === "paused" ? when(drip.pausedAt)
    : when(drip.startedAt)
  const tone =
    drip.status === "paused" ? "text-destructive"
    : drip.status === "completed" ? "text-muted-foreground"
    : "text-foreground"
  return (
    <li className="text-xs leading-relaxed">
      <span className="font-medium">{drip.dripType ?? "drip"}</span>
      <span className={`ml-2 ${tone}`}>{drip.status ?? "unknown"}</span>
      {stamp ? <span className="ml-2 text-muted-foreground">{stamp}</span> : null}
      {drip.startedByMe ? <span className="ml-2 text-muted-foreground">· started by you</span> : null}
      {drip.outcome ? <p className={`mt-0.5 ${tone}`}>{drip.outcome}</p> : null}
    </li>
  )
}

export function SmartDripCard({ contactId }: { contactId: string }) {
  const [dripType, setDripType] = useState<string>("nurture")
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const [drips, setDrips] = useState<ContactDripRow[] | null>(null)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  const loadHistory = useCallback(() => {
    listContactDrips(contactId).then((r) => {
      if (r.success) { setDrips(r.drips ?? []); setHistoryError(null) }
      // Fail LOUD: an unread refusal would render as "never dripped" (§4).
      else { setDrips(null); setHistoryError(r.error ?? "Could not read drip history.") }
    })
  }, [contactId])

  useEffect(() => { loadHistory() }, [loadHistory])

  function start() {
    startTransition(async () => {
      setMessage(null)
      const result = await startSmartDrip(contactId, dripType)
      if (!result.success) {
        setMessage({ ok: false, text: result.error ?? "The drip was not started." })
        loadHistory()
        return
      }
      setMessage({
        ok: true,
        text: result.alreadyEnrolled
          ? `Already enrolled in “${result.sequenceName ?? dripType}” — not double-enrolled.`
          : `Enrolled in “${result.sequenceName ?? dripType}” — the sequence steps take it from here.`,
      })
      loadHistory()
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

        <div className="border-t pt-3">
          <p className="text-xs font-medium mb-1.5">Drip history</p>
          {historyError ? (
            <p className="text-xs text-destructive">{historyError}</p>
          ) : drips === null ? (
            <p className="text-xs text-muted-foreground">Reading…</p>
          ) : drips.length === 0 ? (
            <p className="text-xs text-muted-foreground">No drip has been started for this contact.</p>
          ) : (
            <ul className="space-y-1.5">
              {drips.map((d) => <DripHistoryLine key={d.id} drip={d} />)}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
