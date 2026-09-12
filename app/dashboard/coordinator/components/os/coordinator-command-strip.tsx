'use client'

/**
 * Coordinator Command Strip.
 *
 * WAS: four buttons — "Critical Actions", "Escalations", "Completions",
 * "Pending" — with no counts, no data source and no handlers. Three of those
 * four labels named buckets the product does not compute anywhere, so they were
 * removed rather than given a fabricated number.
 *
 * NOW: the strip reads the REAL cross-surface aggregator the platform already
 * has — getOverdueSummary() (app/actions/overdue.ts), the role-aware roll-up of
 * transaction_tasks / transaction_milestones / transaction_deadlines / licenses /
 * gifts / pre-approvals. Each tile carries a live count, and selecting one
 * reveals the actual rows behind it; every row deep-links through the item's own
 * `href`, which the action supplies. Nothing here is derived from mock data.
 */

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { AlertCircle, Calendar, ClipboardList, Flag, ArrowRight, Loader2 } from 'lucide-react'
import { getOverdueSummary } from '@/app/actions/overdue'
import type { OverdueItem, OverdueSummary } from '@/app/actions/overdue'

interface CoordinatorCommandStripProps {
  /** Kept for the dashboard's call signature — getOverdueSummary scopes itself
   *  from the signed-in session (brokerage + role), so no id is passed in. */
  brokerageId: string
}

type Bucket = 'critical' | 'deadline' | 'task' | 'milestone'

const BUCKETS: Array<{
  key: Bucket
  label: string
  icon: typeof AlertCircle
  tone: string
  match: (item: OverdueItem) => boolean
}> = [
  {
    key: 'critical',
    label: 'Critical Actions',
    icon: AlertCircle,
    tone: 'text-destructive',
    match: (i) => i.severity === 'critical',
  },
  {
    key: 'deadline',
    label: 'Deadlines',
    icon: Calendar,
    tone: 'text-orange-600',
    match: (i) => i.category === 'deadline',
  },
  {
    key: 'task',
    label: 'Tasks',
    icon: ClipboardList,
    tone: 'text-blue-600',
    match: (i) => i.category === 'task',
  },
  {
    key: 'milestone',
    label: 'Milestones',
    icon: Flag,
    tone: 'text-green-600',
    match: (i) => i.category === 'milestone',
  },
]

export function CoordinatorCommandStrip({ brokerageId }: CoordinatorCommandStripProps) {
  const [summary, setSummary] = useState<OverdueSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [active, setActive] = useState<Bucket | null>(null)

  useEffect(() => {
    let cancelled = false
    getOverdueSummary()
      .then((res) => {
        if (!cancelled) setSummary(res)
      })
      .catch((err: unknown) => {
        // Report what the call actually returned; never guess at a cause.
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const items = summary?.items ?? []
  const activeBucket = BUCKETS.find((b) => b.key === active) ?? null
  const activeItems = activeBucket ? items.filter(activeBucket.match) : []

  return (
    <Card className="border-2 border-primary/20 bg-gradient-to-r from-primary/5 to-primary/10">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-lg">Coordinator Command Strip</CardTitle>
            <CardDescription>
              {loading
                ? 'Loading everything that is late…'
                : loadError
                  ? `Overdue roll-up could not be loaded: ${loadError}`
                  : `${summary?.totalCount ?? 0} item${(summary?.totalCount ?? 0) === 1 ? '' : 's'} past due across your deals`}
            </CardDescription>
          </div>
          <Link
            href="/dashboard/overdue"
            className="text-xs font-medium text-primary hover:underline inline-flex items-center gap-1"
          >
            Open Overdue <ArrowRight className="h-3 w-3" />
          </Link>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-4 gap-3">
          {BUCKETS.map((bucket) => {
            const Icon = bucket.icon
            const count = items.filter(bucket.match).length
            return (
              <Button
                key={bucket.key}
                variant={active === bucket.key ? 'default' : 'outline'}
                className="flex flex-col h-auto py-3"
                size="sm"
                disabled={loading || !!loadError}
                aria-pressed={active === bucket.key}
                onClick={() => setActive((prev) => (prev === bucket.key ? null : bucket.key))}
              >
                {loading ? (
                  <Loader2 className="h-4 w-4 mb-1 animate-spin" />
                ) : (
                  <Icon className={`h-4 w-4 mb-1 ${active === bucket.key ? '' : bucket.tone}`} />
                )}
                <span className="text-xs">{bucket.label}</span>
                {!loading && <span className="text-xs font-semibold">{count}</span>}
              </Button>
            )
          })}
        </div>

        {activeBucket && (
          <div className="rounded-lg border bg-background divide-y max-h-64 overflow-y-auto">
            {activeItems.length === 0 ? (
              <p className="px-3 py-4 text-sm text-muted-foreground text-center">
                Nothing past due in {activeBucket.label.toLowerCase()}.
              </p>
            ) : (
              activeItems.map((item) => (
                <Link
                  key={`${item.category}-${item.id}`}
                  href={item.href}
                  className="flex items-center justify-between gap-3 px-3 py-2 hover:bg-muted/50"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{item.title}</p>
                    <p className="text-xs text-muted-foreground truncate">{item.description}</p>
                  </div>
                  <Badge variant="outline" className="shrink-0 text-xs">
                    {item.daysOverdue}d late
                  </Badge>
                </Link>
              ))
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
