// app/dashboard/campaigns/repurpose/refurbish-results-card.tsx
//
// WAVE 154 (lane 154D — directive D4/D5): the reader for refurbished posts. Each row says what is TRUE about it — published
// only when the channel acknowledged it, a rate only when measured, keep / retest only against the tenant's own measured
// baseline. Data: getRefurbishResults (lib/repurpose/actions.ts). Server-rendered; no interaction.

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"

export interface RefurbishResultRow {
  logId: string
  platform: string
  state: string
  why: string
  measuredRate: number | null
  baselineRate: number | null
  decision: string
  decisionWhy: string
  createdAt: string | null
}

const STATE_LABEL: Record<string, string> = { published: "Published (channel accepted)", awaiting_provider: "Waiting on the channel", failed: "Not published", not_scheduled: "No post" }
const DECISION_LABEL: Record<string, string> = { keep: "Keep", retest: "Retest", awaiting_measurement: "Awaiting measurement", not_published: "—" }
const pct = (v: number | null) => (v == null ? "unknown" : `${(v * 100).toFixed(1)}%`)

export function RefurbishResultsCard({ results, error }: { results: RefurbishResultRow[]; error?: string | null }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Refurbished posts — results</CardTitle>
        <CardDescription>Published only when the channel accepted the post; results only when measured.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : results.length === 0 ? (
          <p className="text-sm text-muted-foreground">No refurbished posts yet. Refurbish an idea from SEO / GEO → Market Trends, or from a transcript above.</p>
        ) : (
          results.map((r) => (
            <div key={r.logId} className="flex flex-wrap items-center gap-2 rounded border p-2 text-xs">
              <Badge variant="outline">{r.platform}</Badge>
              <Badge variant={r.state === "published" ? "default" : r.state === "failed" ? "destructive" : "secondary"}>{STATE_LABEL[r.state] ?? r.state}</Badge>
              <span className="text-muted-foreground">{r.why}</span>
              <span>rate {pct(r.measuredRate)} · your baseline {pct(r.baselineRate)}</span>
              <Badge variant="outline" title={r.decisionWhy}>{DECISION_LABEL[r.decision] ?? r.decision}</Badge>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  )
}
