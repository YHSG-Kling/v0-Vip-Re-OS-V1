"use client"

import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { Users, Cpu, Video, Activity, FileText } from "lucide-react"
import { formatTenantSeatLimit, normalizeCatalogSeatLimit } from "@/lib/kernel/tier-role-matrix"
import { PLAN_CARD_METRICS, METRIC_LABELS } from "@/lib/usage/metric-labels"
import type { MetricSnapshot } from "@/app/actions/usage-overview"

// WAVE 143J — THIS CARD NO LONGER INVENTS A PLAN. It used to take `aiCallsLimit`,
// `storageLimitGb` and `videoMinutesLimit` from the page, which computed them as
// `features?.ai_calls_monthly || 1000`, `features?.storage_gb || 5`,
// `features?.video_minutes_monthly || 60` — three keys the live subscription_tiers.features
// object does not carry (it holds eight boolean flags) — so EVERY tenant saw a 1,000-call /
// 5 GB / 60-minute allowance beside usage read from billing_usage, a table most of these
// counters never reach. The allowances are plan_limits rows and the counts are
// usage_counters / live rows, and app/actions/usage-overview.ts:loadUsageOverview (the
// /dashboard/settings/usage survivor) already joins them honestly, so this card renders ITS
// answer: same limits, same counters, same "Not measured yet" rule (lib/usage/metric-labels.ts).
// Storage is no longer drawn — nothing measures it, and an unmeasured bar is a number nobody took.

interface UsageSectionProps {
  /** loadUsageOverview().data — null when it could not be read (see `error`). */
  overview: { metrics: MetricSnapshot[] } | null
  /** Why the overview is absent, shown instead of an empty-looking meter. */
  error: string | null
  /** Catalogue seat cap. `null` = UNLIMITED — the spelling the live
   *  multi_location tier actually stores in subscription_tiers.max_agents.
   *  This used to be a bare `number` fed by `max_agents || 1`, which turned
   *  the unlimited plan into a ONE-seat cap and drew the bar pegged at 100%. */
  maxAgents: number | null
  /** Whether a catalogue tier row was actually read. `false` means NO PLAN —
   *  which reaches `maxAgents` as the same `null` unlimited uses, and used to
   *  print "Unlimited". An absent entitlement is not the largest one (§4). */
  hasTier: boolean
}

const ICONS: Record<string, typeof Cpu> = {
  ai_tokens_monthly: Cpu,
  video_minutes: Video,
  live_avatar_minutes: Activity,
  contacts_count: Users,
  active_transactions: FileText,
}

function getProgressColor(percent: number): string {
  if (percent >= 95) return "bg-red-500"
  if (percent >= 80) return "bg-amber-500"
  return "bg-blue-500"
}

interface MeterRow {
  key: string
  label: string
  icon: typeof Cpu
  current: string
  max: string
  percent: number
  measured: boolean
}

export function UsageSection({ overview, error, maxAgents, hasTier }: UsageSectionProps) {
  const byMetric = new Map((overview?.metrics ?? []).map((m) => [m.metric, m]))

  // null = unlimited ⇒ no percentage to draw. Folded through the ONE shared
  // normalizer so display and the seat gate cannot disagree.
  const seatCap = normalizeCatalogSeatLimit(maxAgents)
  const seats = byMetric.get("active_users")
  const seatsMeasured = !!seats && seats.source !== "unmeasured"
  const seatsUsed = seatsMeasured ? seats.used : 0
  const seatPercent = seatsMeasured && seatCap !== null && seatCap > 0 ? Math.min((seatsUsed / seatCap) * 100, 100) : 0

  const rows: MeterRow[] = [
    {
      key: "seats",
      label: "Seats in use",
      icon: Users,
      current: seatsMeasured ? String(seatsUsed) : "—",
      max: formatTenantSeatLimit(hasTier, maxAgents),
      percent: seatPercent,
      measured: seatsMeasured,
    },
  ]
  for (const metric of PLAN_CARD_METRICS) {
    const m = byMetric.get(metric)
    if (!m) continue // the tier carries no limit row for it — nothing to compare against
    const measured = m.source !== "unmeasured"
    rows.push({
      key: metric,
      label: METRIC_LABELS[metric] ?? metric,
      icon: ICONS[metric] ?? Activity,
      current: measured ? m.used.toLocaleString() : "—",
      max: m.unlimited ? "Unlimited" : m.limit.toLocaleString(),
      percent: measured && !m.unlimited ? m.percent : 0,
      measured,
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Usage This Period</CardTitle>
        <CardDescription>
          Your consumption against what your plan includes.{" "}
          <Link href="/dashboard/settings/usage" className="underline underline-offset-2">See every metric</Link>
        </CardDescription>
      </CardHeader>
      <CardContent>
        {error && (
          <p className="mb-4 text-sm text-amber-700" role="status">
            {error}
          </p>
        )}
        <div className="grid gap-6 md:grid-cols-2">
          {rows.map((item) => {
            const Icon = item.icon
            const colorClass = getProgressColor(item.percent)

            return (
              <div key={item.key} className="space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <Icon className="h-4 w-4 text-muted-foreground" />
                    {item.label}
                  </div>
                  <span className="text-sm text-muted-foreground">
                    {item.measured ? `${item.current} / ${item.max}` : `Not measured yet · ${item.max} included`}
                  </span>
                </div>
                {item.measured && (
                  <div className="relative">
                    <Progress
                      value={item.percent}
                      className="h-2"
                    />
                    <div
                      className={`absolute top-0 left-0 h-2 rounded-full transition-all ${colorClass}`}
                      style={{ width: `${item.percent}%` }}
                    />
                  </div>
                )}
                {item.measured && item.percent >= 80 && (
                  <p className={`text-xs ${item.percent >= 95 ? "text-red-600" : "text-amber-700"}`}>
                    {item.percent >= 95
                      ? "Included allowance reached for this period."
                      : "Approaching your included allowance."}
                  </p>
                )}
              </div>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}
