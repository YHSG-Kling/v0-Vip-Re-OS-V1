"use client"

/**
 * app/crm/components/contacts-analytics-strip.tsx
 *
 * THE READER app/actions/contacts.ts:64-67 RULED HAD TO BE BUILT.
 *
 * That tombstone retired five /api/contacts HTTP twins and then said, of the
 * sixth: "NOT retired: app/api/contacts/analytics/route.ts. It has no duplicate
 * here — no function in this file computes by_type / by_persona / by_status /
 * by_timeline / conversion_rate, and nothing else in the tree does either. Per
 * the orphan doctrine that is a BUILD (give it a reader), not a delete."
 * This is that reader. The route stays the implementation; this only calls it.
 *
 * WHY /crm AND NOT A NEW PAGE — the endpoint answers "what does my book look
 * like", and /crm ("My Contacts (CRM)", app/components/command-palette.tsx:29)
 * is the one surface where a broker or agent reads their book. A separate
 * analytics page would have been a second door onto the same question.
 *
 * WHAT THE NUMBERS ARE, AND ARE NOT — the route computes over the SESSION's
 * tenant (CLAUDE.md §4: never a body, never a param): the whole brokerage for a
 * broker/admin, the caller's own contacts for an agent. It knows nothing about
 * the search box or the type tabs on the page below it, so this strip says so
 * rather than letting a filtered list and an unfiltered total silently disagree.
 *
 * THREE DISTINCT STATES, none of them a lie:
 *   · loading  — skeleton, no numbers at all
 *   · refused  — the reason, and NO numbers (a failed read is not "0 contacts")
 *   · loaded   — the counts, including an honest empty book
 * The response is READ before anything renders: `res.ok`, then the parsed
 * `success` flag, then the payload. Nothing here reports a total it did not
 * receive.
 */

import { useCallback, useEffect, useState } from "react"
import { BarChart3, Loader2, RefreshCw } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
// §6 — ONE VOCABULARY. types/contact.ts already declares the exact shape
// /api/contacts/analytics returns, and it sat orphaned for the same reason the
// route did: nothing read either half. Declaring a local twin here would have
// been a second spelling of one payload, and the two would drift the first time
// the route gained a field. Imported, not re-declared.
import type { ContactAnalytics } from "@/types/contact"

/** Breakdown keys are rendered as the route returned them — this strip does not
 *  invent a second spelling of any vocabulary (CLAUDE.md §6), it only softens
 *  the underscores for display. */
function humanize(key: string): string {
  return key.replace(/_/g, " ")
}

function Breakdown({ label, counts }: { label: string; counts: Record<string, number> }) {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1])
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      {entries.length === 0 ? (
        <p className="text-xs text-muted-foreground">Not recorded on any contact yet</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {entries.map(([key, n]) => (
            <Badge key={key} variant="secondary" className="text-[11px] font-normal capitalize">
              {humanize(key)} · {n}
            </Badge>
          ))}
        </div>
      )}
    </div>
  )
}

export function ContactsAnalyticsStrip() {
  const [analytics, setAnalytics] = useState<ContactAnalytics | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch("/api/contacts/analytics", { cache: "no-store" })
      // EVERY ARM OF THE RESPONSE IS READ. A 401/403/500 carries a JSON body
      // with the reason on this route; showing the strip's numbers over an
      // unread response is the defect this repo has shipped before.
      const payload = await res.json().catch(() => null)
      if (!res.ok || !payload?.success || !payload?.analytics) {
        setAnalytics(null)
        setError(
          (payload && typeof payload.error === "string" && payload.error) ||
            `Your book could not be read (HTTP ${res.status}).`,
        )
        return
      }
      setAnalytics(payload.analytics as ContactAnalytics)
    } catch (err: unknown) {
      setAnalytics(null)
      setError(err instanceof Error ? err.message : "Your book could not be read.")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <BarChart3 className="h-4 w-4" />
              Book at a glance
            </CardTitle>
            <CardDescription className="text-xs">
              Everything you are allowed to see, counted server-side — brokerage-wide for a
              broker or admin, your own contacts as an agent. Not affected by the search or
              the type tabs below.
            </CardDescription>
          </div>
          <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading}>
            {loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            <span className="sr-only">Refresh book analytics</span>
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <p className="text-sm text-muted-foreground">Counting your book…</p>
        ) : error ? (
          <p className="text-sm text-destructive">
            No number below is a reading of your book: {error}
          </p>
        ) : !analytics ? null : analytics.total === 0 ? (
          <p className="text-sm text-muted-foreground">
            No contacts on record yet — this is an empty book, not a failed read.
          </p>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-3">
              <div>
                <p className="text-2xl font-semibold tabular-nums">{analytics.total}</p>
                <p className="text-xs text-muted-foreground">Contacts</p>
              </div>
              <div>
                <p className="text-2xl font-semibold tabular-nums">
                  {analytics.conversion_rate.toFixed(1)}%
                </p>
                <p className="text-xs text-muted-foreground">Qualified or beyond</p>
              </div>
              <div>
                <p className="text-2xl font-semibold tabular-nums">{analytics.with_login}</p>
                <p className="text-xs text-muted-foreground">With a portal login</p>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Breakdown label="By type" counts={analytics.by_type} />
              <Breakdown label="By status" counts={analytics.by_status} />
              <Breakdown label="By persona" counts={analytics.by_persona} />
              <Breakdown label="By timeline" counts={analytics.by_timeline} />
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
