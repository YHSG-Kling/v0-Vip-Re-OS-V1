"use client"

import { useState } from "react"
import { RotateCcw } from "lucide-react"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { RawPipelineStats } from "./pipeline-stats"

/**
 * Pipeline stats card — the missing IN-TREE caller for GET
 * /api/leads/process-pipeline (lane 64D, route-no-caller 6b → 0).
 *
 * ./page.tsx (a server component) still renders the FIRST paint through the
 * in-process call the route's own header documents
 * (loadRawPipelineStats(brokerageId), no self-fetch, no cookie-forwarding —
 * that header explains why). What page.tsx cannot do is give the card a
 * refresh: a server component only re-runs on navigation, so the funnel
 * numbers on a screen an ops seat leaves open all day go stale. This client
 * card adds exactly that — a "Refresh" button that hits the EXTERNAL door
 * (the route) the way a browser session actually can, since the tenant here
 * comes from the session cookie the fetch carries, never a parameter
 * (CLAUDE.md §4). The route re-runs the identical two gates
 * (requireBrokerAuth + resolveLeadVisibility) on every call, so a seat that
 * loses access mid-session sees the refusal, not stale numbers.
 */
export function PipelineStatsPanel({
  initialStats,
  rejectionLabel,
  refusedForTeam,
}: {
  initialStats: { ok: true; stats: RawPipelineStats } | { ok: false; error: string } | null
  rejectionLabel: Record<string, string>
  refusedForTeam: boolean
}) {
  const [stats, setStats] = useState(initialStats)
  const [loading, setLoading] = useState(false)
  const [refreshError, setRefreshError] = useState<string | null>(null)

  async function refresh() {
    setLoading(true)
    setRefreshError(null)
    try {
      const res = await fetch("/api/leads/process-pipeline", { cache: "no-store" })
      const body = await res.json() as RawPipelineStats | { error: string }
      if (!res.ok) {
        setRefreshError("error" in body ? body.error : `HTTP ${res.status}`)
        return
      }
      setStats({ ok: true, stats: body as RawPipelineStats })
    } catch (e) {
      setRefreshError(String(e))
    } finally {
      setLoading(false)
    }
  }

  return (
    <Card className="p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs font-medium">Pipeline stats · by processing status</div>
        {!refusedForTeam && (
          <Button size="sm" variant="ghost" disabled={loading} onClick={refresh} className="h-6 gap-1 text-xs">
            <RotateCcw className="h-3 w-3" />
            {loading ? "Refreshing…" : "Refresh"}
          </Button>
        )}
      </div>
      {refreshError && <div className="text-xs text-red-600 mb-2">Refresh failed: {refreshError}</div>}
      {refusedForTeam ? (
        <div className="text-sm text-muted-foreground">
          Brokerage-level only — raw-pipeline totals cannot be scoped to a team, so they are not shown for a
          team-scoped seat.
        </div>
      ) : !stats ? (
        <div className="text-sm text-muted-foreground">Pipeline stats are unavailable for this seat.</div>
      ) : !stats.ok ? (
        <div className="text-sm text-red-700">Pipeline stats could not be read: {stats.error}</div>
      ) : (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-1.5">
            <Badge className="tabular-nums">total {stats.stats.raw_scraped_leads.total}</Badge>
            {Object.entries(stats.stats.raw_scraped_leads)
              .filter(([k, n]) => k !== "total" && n > 0)
              .map(([status, n]) => (
                <Badge key={status} variant="outline" className="tabular-nums">
                  {rejectionLabel[status] ?? status} {n}
                </Badge>
              ))}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
            <span className="tabular-nums">
              dedup skips logged: {stats.stats.deduplication.duplicates_found}
            </span>
            {Object.keys(stats.stats.vendor_costs).length === 0 ? (
              <span>vendor spend: none recorded</span>
            ) : (
              Object.entries(stats.stats.vendor_costs).map(([vendor, cost]) => (
                <span key={vendor} className="tabular-nums">
                  {vendor}: ${cost.toFixed(2)}
                </span>
              ))
            )}
          </div>
        </div>
      )}
    </Card>
  )
}
