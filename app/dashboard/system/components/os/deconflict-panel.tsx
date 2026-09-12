'use client'

/**
 * De-Conflict Engine panel — the broker cockpit reader promised at
 * lib/kernel/deconflict/index.ts:36. Shows the last week of engine decisions
 * (allowed AND suppressed) with the per-channel rollup, so a broker can see
 * lane saturation and which outbounds the over-touch / cooldown policies
 * deferred, and why.
 *
 * Loads via the getDeconflictActivity server action (session-gated,
 * brokerage-scoped) — the same action-backed pattern as the sibling
 * ServiceSLAPanel / ObservabilityPanel. A refused read renders as a refusal,
 * never as "0 suppressed" (§4).
 */

import { useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { ShieldAlert, ShieldCheck, AlertTriangle } from 'lucide-react'
import {
  getDeconflictActivity,
  type DeconflictActivityRead,
} from '@/app/actions/deconflict-cockpit'

interface DeconflictPanelProps {
  brokerageId: string
}

const OUTCOME_BADGE: Record<string, string> = {
  allowed: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
  suppressed_over_touch: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
  suppressed_cooldown: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300',
}

function outcomeLabel(outcome: string): string {
  if (outcome === 'allowed') return 'allowed'
  if (outcome === 'suppressed_over_touch') return 'over-touch'
  if (outcome === 'suppressed_cooldown') return 'cooldown'
  return outcome.replace(/_/g, ' ')
}

function recipientLabel(d: {
  contact_id: string | null
  recipient_email: string | null
  recipient_phone: string | null
}): string {
  if (d.recipient_email) return d.recipient_email
  if (d.recipient_phone) return d.recipient_phone
  if (d.contact_id) return `contact ${d.contact_id.slice(0, 8)}…`
  return 'brokerage-wide'
}

export function DeconflictPanel({ brokerageId }: DeconflictPanelProps) {
  const [loading, setLoading] = useState(true)
  const [read, setRead] = useState<DeconflictActivityRead | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      try {
        const result = await getDeconflictActivity(7)
        if (!cancelled) setRead(result)
      } catch {
        if (!cancelled) {
          setRead({ status: 'unavailable', detail: 'The de-conflict read failed to run.' })
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
    // brokerageId is the tenant this page rendered for; the action re-derives it
    // from the session, so the prop is only a reload key.
  }, [brokerageId])

  if (loading) {
    return (
      <Card className="border-border bg-card">
        <CardContent className="flex items-center justify-center py-8">
          <ShieldAlert className="h-6 w-6 animate-pulse text-muted-foreground" />
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className="border-border bg-card">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg font-semibold flex items-center gap-2">
            <ShieldAlert className="h-5 w-5 text-primary" />
            De-Conflict Engine
          </CardTitle>
          {read?.status === 'ok' && read.data.suppressed > 0 && (
            <Badge variant="destructive">{read.data.suppressed} deferred</Badge>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          Cross-channel over-touch protection — last 7 days of send decisions
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {read?.status === 'unavailable' && (
          <div className="flex items-start gap-2 rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/20 p-3">
            <AlertTriangle className="h-4 w-4 mt-0.5 text-red-600 shrink-0" />
            <p className="text-sm text-red-700 dark:text-red-300">{read.detail}</p>
          </div>
        )}

        {read?.status === 'empty' && (
          <div className="flex items-start gap-2 rounded-lg bg-muted/40 p-3">
            <ShieldCheck className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
            <p className="text-sm text-muted-foreground">{read.detail}</p>
          </div>
        )}

        {read?.status === 'ok' && (
          <>
            {/* Channel saturation rollup */}
            <div className="grid grid-cols-2 gap-3">
              {read.data.byChannel.map((c) => (
                <div key={c.channel} className="rounded-lg border border-border p-3">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">{c.channel}</p>
                  <div className="mt-1 flex items-baseline gap-3">
                    <span className="text-sm text-green-700 dark:text-green-400">{c.allowed} allowed</span>
                    <span className={`text-sm ${c.suppressed > 0 ? 'text-red-700 dark:text-red-400 font-medium' : 'text-muted-foreground'}`}>
                      {c.suppressed} deferred
                    </span>
                  </div>
                </div>
              ))}
            </div>

            {/* §1.2 — WHICH AUDIENCE the cooldown silenced, from
                deconflict_suppression_log.metadata.segment. A broadcast
                suppression carries no contact_id, so before this the panel
                could say "3 email deferred" and nothing about who they were. */}
            {read.data.suppressedSegments.length > 0 && (
              <div className="rounded-lg border border-border p-3">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Audiences a cooldown silenced</p>
                <ul className="mt-1 space-y-0.5">
                  {read.data.suppressedSegments.slice(0, 8).map((s) => (
                    <li key={s.segment} className="text-sm flex items-center justify-between gap-3">
                      <span className="truncate">{s.segment}</span>
                      <span className="text-red-700 dark:text-red-400 shrink-0">{s.suppressed} deferred</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Most recent decisions, suppressions first in reading priority */}
            <div className="space-y-2">
              <p className="text-sm font-medium text-muted-foreground">Recent decisions</p>
              <div className="space-y-2 max-h-56 overflow-y-auto">
                {read.data.decisions.slice(0, 12).map((d) => (
                  <div key={d.id} className="rounded-lg border border-border p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">
                          {d.channel} · {recipientLabel(d)}
                        </p>
                        <p className="text-xs text-muted-foreground truncate">
                          {d.reason
                            ?? (d.outcome === 'allowed'
                              ? `${d.touches_in_window ?? 0}/${d.policy_max ?? '?'} touches in ${d.window_days ?? '?'}d — under policy`
                              : 'deferred')}
                        </p>
                        {d.system_source && (
                          <p className="text-[11px] text-muted-foreground">source: {d.system_source}</p>
                        )}
                      </div>
                      <Badge className={`text-xs shrink-0 ${OUTCOME_BADGE[d.outcome] ?? 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300'}`}>
                        {outcomeLabel(d.outcome)}
                      </Badge>
                    </div>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      {new Date(d.created_at).toLocaleString()}
                    </p>
                  </div>
                ))}
              </div>
              <p className="text-[11px] text-muted-foreground">
                {read.data.total} decision{read.data.total === 1 ? '' : 's'} since{' '}
                {new Date(read.data.sinceIso).toLocaleDateString()} (showing newest 12 of up to 500 loaded)
              </p>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
