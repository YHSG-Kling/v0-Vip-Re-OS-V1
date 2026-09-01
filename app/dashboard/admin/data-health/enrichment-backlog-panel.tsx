"use client"

/**
 * ENRICHMENT BACKLOG PANEL — the Data Steward surface for the three enrichment
 * work-list actions that had no caller.
 *
 * `getUnenrichedContacts` and `getContactsNeedingLifeChangeCheck` existed only
 * because the nightly cron used to call them; when that cron was rebuilt onto
 * the tenant-explicit library (it has no session, so a session-gated reader
 * returned an empty list on every run) both were left with no caller at all.
 * `enrichContactsBatch` never had one. They are not dead — they are the answer
 * to "who is the platform missing data on, and can I do something about it
 * right now", which nothing in the product could ask.
 *
 * Lives on Data Health because that is the Data Steward's page and this is a
 * data-completeness question.
 *
 * WHAT THE NUMBERS MEAN, stated because it is easy to misread them: both readers
 * ALREADY EXCLUDE contacts with an active listing or an active transaction, per
 * the owner's rule that enrichment runs before or after a deal but never during
 * one. So "12 awaiting enrichment" means twelve contacts that are eligible right
 * now — not twelve contacts the system has forgotten. Contacts inside a live
 * deal are deliberately absent from both lists.
 *
 * The bulk button is capped by the action itself (200 ids) and every id costs
 * real third-party spend, so the panel enriches only what it is showing.
 */

import { useCallback, useEffect, useState, useTransition } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Loader2, Sparkles, Users } from "lucide-react"
import {
  getUnenrichedContacts,
  getContactsNeedingLifeChangeCheck,
  getEnrichmentQueueHealth,
  enrichContactsBatch,
} from "@/app/actions/contact-enrichment"

const PAGE_LIMIT = 50

interface QueueFailureRow {
  id: string
  enrichment_type: string | null
  error_message: string | null
  retry_count: number | null
  queued_at: string | null
}

export function EnrichmentBacklogPanel() {
  const [unenriched, setUnenriched] = useState<Array<{ id: string }>>([])
  const [dueForCheck, setDueForCheck] = useState<Array<{ id: string }>>([])
  const [queueFailures, setQueueFailures] = useState<QueueFailureRow[]>([])
  const [spend30d, setSpend30d] = useState<number | null>(null)
  const [queueError, setQueueError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [notice, setNotice] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  const load = useCallback(async () => {
    setLoading(true)
    const [a, b, q] = await Promise.all([
      getUnenrichedContacts(PAGE_LIMIT),
      getContactsNeedingLifeChangeCheck(PAGE_LIMIT),
      getEnrichmentQueueHealth(10),
    ])
    setUnenriched(a.contacts ?? [])
    setDueForCheck(b.contacts ?? [])
    setQueueFailures(q.recentFailures ?? [])
    // A refused queue read renders as "unavailable", never as $0 spent.
    setQueueError(q.error ?? null)
    setSpend30d(q.error ? null : q.spend30d)
    setLoading(false)
  }, [])

  useEffect(() => { void load() }, [load])

  const enrichBacklog = () => {
    setNotice(null)
    const ids = unenriched.map((c) => c.id)
    if (ids.length === 0) return
    startTransition(async () => {
      const res = await enrichContactsBatch(ids, { source: "manual" })
      setNotice(
        res.error
          ? res.error
          : `${res.success} enriched · ${res.skipped} skipped (live deal, already enriched, or no identifier to look up) · ${res.failed} failed`,
      )
      await load()
    })
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-sm flex items-center gap-2">
              <Users className="h-4 w-4 text-primary" />
              Enrichment backlog
            </CardTitle>
            <CardDescription className="text-xs">
              Contacts eligible for enrichment right now. Anyone with an active listing or an
              active transaction is deliberately excluded — enrichment runs before or after a
              deal, never during one.
            </CardDescription>
          </div>
          <Button
            size="sm"
            onClick={enrichBacklog}
            disabled={isPending || loading || unenriched.length === 0}
            className="shrink-0"
          >
            {isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
            <span className="ml-1">Enrich these {unenriched.length || ""}</span>
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <p className="text-xs text-muted-foreground flex items-center gap-2">
            <Loader2 className="h-3 w-3 animate-spin" /> Loading backlog…
          </p>
        ) : (
          <div className="flex flex-wrap gap-4">
            <div className="flex items-center gap-2">
              <Badge variant={unenriched.length ? "default" : "secondary"}>{unenriched.length}</Badge>
              <span className="text-xs text-muted-foreground">
                never enriched{unenriched.length === PAGE_LIMIT ? " (showing first 50)" : ""}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant={dueForCheck.length ? "default" : "secondary"}>{dueForCheck.length}</Badge>
              <span className="text-xs text-muted-foreground">
                due a life-change re-check{dueForCheck.length === PAGE_LIMIT ? " (showing first 50)" : ""}
              </span>
            </div>
          </div>
        )}
        {notice && (
          <p className="text-xs rounded border bg-muted/40 px-2 py-1.5 text-muted-foreground">{notice}</p>
        )}

        {/* Queue health — failure reasons + spend. The orchestrator stamps
            error_message on every failure and enrichment_cost on every paid
            lookup; until this section nothing ever showed either, so a
            failing vendor and its spend were both invisible. */}
        {!loading && (
          <div className="space-y-2 border-t pt-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium">Enrichment queue health</span>
              <span className="text-xs text-muted-foreground">
                {queueError
                  ? "spend unavailable"
                  : `$${(spend30d ?? 0).toFixed(2)} spent last 30 days`}
              </span>
            </div>
            {queueError ? (
              <p className="text-xs text-destructive">Queue read failed: {queueError}</p>
            ) : queueFailures.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">No failed queue items.</p>
            ) : (
              <ul className="space-y-1">
                {queueFailures.map((f) => (
                  <li key={f.id} className="text-[11px] text-muted-foreground flex items-start justify-between gap-2">
                    <span className="truncate" title={f.error_message ?? undefined}>
                      <span className="font-medium text-foreground">{f.enrichment_type ?? "enrichment"}</span>
                      {" — "}
                      {f.error_message ?? "no reason recorded"}
                    </span>
                    <span className="shrink-0">
                      {f.retry_count != null ? `${f.retry_count} retr${f.retry_count === 1 ? "y" : "ies"}` : ""}
                      {f.queued_at ? ` · ${new Date(f.queued_at).toLocaleDateString()}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <p className="text-[11px] text-muted-foreground">
          The scheduled sweep picks these up on its own; this is the manual lever for when you do
          not want to wait. Each contact costs a paid third-party lookup, so the bulk action only
          enriches the contacts listed above.
        </p>
      </CardContent>
    </Card>
  )
}
