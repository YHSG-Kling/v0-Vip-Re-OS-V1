// app/components/analytics/prediction-accuracy-panel.tsx
//
// THE TRUST SURFACE (owner round 35) — the ONE "Prediction Accuracy" panel,
// mounted twice from the same component (keep-one):
//   (a) superadmin platform analytics — cross-tenant (absorbs the round-34
//       closing-cost rollup as its first rail)
//   (b) broker analytics — tenant-scoped
// Pure presentational server component over the unified aggregator's report.
// Honest empty states per rail: an unavailable rail SHOWS its why; nothing
// renders an invented number. Each rail names its prediction + outcome ledgers
// and links to its detail source.

import { Fragment } from "react"
import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Gauge } from "lucide-react"
import type {
  PredictionAccuracyReport,
  PredictionTrustChip,
  RailAccuracy,
  RailBreakdownRow,
} from "@/lib/analytics/prediction-accuracy"

function fmtMedianError(m: NonNullable<RailAccuracy["medianError"]>): string {
  switch (m.unit) {
    case "usd":          return `±$${Math.round(m.value).toLocaleString("en-US")}`
    case "pct_of_sale":  return `±${(m.value * 100).toFixed(1)}%`
    case "days":         return `±${Math.round(m.value)} day${Math.round(m.value) === 1 ? "" : "s"}`
    case "people":       return `±${Math.round(m.value)} ${Math.round(m.value) === 1 ? "person" : "people"}`
    case "score_points": return `±${Math.round(m.value)} pts`
    case "probability_pts": return `±${Math.round(m.value)} prob. pts`
  }
}

function withinBadge(rate: number) {
  const pct = Math.round(rate * 100)
  const cls =
    rate >= 0.7 ? "bg-emerald-100 text-emerald-800" :
    rate >= 0.4 ? "bg-amber-100 text-amber-800" :
    "bg-red-100 text-red-800"
  return <Badge className={`${cls} text-xs`}>{pct}%</Badge>
}

// A breakdown row used to be rendered with a HARDCODED `±$` — right while every
// breakdown row came from the closing-cost rail, wrong the moment the content
// rail started publishing rows in percentage points. `unit` is optional and
// absent means "usd", so the closing-cost rows render exactly as before.
// A row with no medianError is NOT a zero miss: it is an outcome that has not
// been reconciled yet, and it says so.
function fmtBreakdownError(b: RailBreakdownRow): string {
  if (b.medianError == null) return "not yet measured"
  switch (b.unit ?? "usd") {
    case "score_points": return `±${Math.round(b.medianError)} pts`
    case "pct_points":   return `±${b.medianError.toFixed(2)} pp`
    case "usd":
    default:             return `±$${Math.round(b.medianError).toLocaleString("en-US")}`
  }
}

function fmtPeriod(p: RailAccuracy["period"]): string {
  if (!p) return "—"
  const d = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", year: "numeric" })
  const from = d(p.from), to = d(p.to)
  return from === to ? from : `${from} – ${to}`
}

export function PredictionAccuracyPanel({
  report,
  scopeLabel,
  trustChip,
}: {
  report: PredictionAccuracyReport
  /** e.g. "all tenants" or "your brokerage" */
  scopeLabel: string
  /** the client-facing chip, when a rail crossed its threshold (else omitted) */
  trustChip?: PredictionTrustChip | null
}) {
  const graded = report.rails.filter((r) => r.available)
  const ungraded = report.rails.filter((r) => !r.available)

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <Gauge className="h-4 w-4 text-primary" />
          Prediction accuracy — the system grades itself
          <span className="ml-auto text-xs font-normal text-muted-foreground">
            {scopeLabel} · {report.gradedRails} of {report.rails.length} rails graded · {report.totalObservations} observation{report.totalObservations === 1 ? "" : "s"}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {trustChip && (
          <div className="mx-4 mb-3 rounded border border-emerald-200 bg-emerald-50/50 px-3 py-2">
            <p className="text-xs font-medium text-emerald-900">
              <span className="uppercase tracking-wide mr-2 text-[10px] text-emerald-700">Measured, not claimed</span>
              {trustChip.line}
            </p>
          </div>
        )}

        {graded.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">
            No prediction rail has outcome data yet. Every rail below grades itself only
            from recorded outcomes (settlement statements, Closing Disclosures, sold
            prices, head counts, human verdicts) — an empty ledger stays empty here.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/10">
                  <th className="text-left px-4 py-2 font-medium text-muted-foreground">Prediction rail</th>
                  <th className="text-right px-4 py-2 font-medium text-muted-foreground">Graded</th>
                  <th className="text-right px-4 py-2 font-medium text-muted-foreground">Median miss</th>
                  <th className="text-right px-4 py-2 font-medium text-muted-foreground" title="share inside the SOURCE-defined tolerance — only shown where the source system defines one">Within tolerance</th>
                  <th className="text-left px-4 py-2 font-medium text-muted-foreground">Window</th>
                </tr>
              </thead>
              <tbody>
                {graded.map((r) => (
                  <Fragment key={r.rail}>
                    <tr className="border-b last:border-0 hover:bg-muted/10 align-top">
                      <td className="px-4 py-2.5">
                        {r.detailHref ? (
                          <Link href={r.detailHref} className="font-medium hover:underline">{r.label}</Link>
                        ) : (
                          <span className="font-medium">{r.label}</span>
                        )}
                        <p className="text-[11px] text-muted-foreground mt-0.5">
                          {r.predictionSource} → {r.outcomeSource}
                        </p>
                        {r.honestNotes.map((n, i) => (
                          <p key={i} className="text-[11px] text-muted-foreground/80 mt-0.5">{n}</p>
                        ))}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{r.observations}</td>
                      <td className="px-4 py-2.5 text-right font-medium" title={r.medianError?.label ?? undefined}>
                        {r.medianError ? fmtMedianError(r.medianError) : <span className="text-muted-foreground">—</span>}
                      </td>
                      <td className="px-4 py-2.5 text-right" title={r.withinRate?.label ?? "no source-defined tolerance on this rail — median miss only, nothing invented"}>
                        {r.withinRate ? withinBadge(r.withinRate.rate) : <span className="text-xs text-muted-foreground">no band</span>}
                      </td>
                      <td className="px-4 py-2.5 text-xs text-muted-foreground whitespace-nowrap">{fmtPeriod(r.period)}</td>
                    </tr>
                    {(r.breakdown ?? []).map((b) => (
                      <tr key={`${r.rail}-${b.group}`} className="border-b last:border-0 bg-muted/5">
                        <td className="pl-8 pr-4 py-1.5 text-xs text-muted-foreground">
                          {b.group}
                          {b.pending != null && b.pending > 0 && (
                            <span className="ml-2 text-[10px] text-muted-foreground/70">
                              {b.pending} not yet measured
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-1.5 text-right text-xs text-muted-foreground tabular-nums">{b.observations}</td>
                        <td className="px-4 py-1.5 text-right text-xs text-muted-foreground tabular-nums">
                          {fmtBreakdownError(b)}
                        </td>
                        <td className="px-4 py-1.5 text-right">
                          {b.withinRate != null ? withinBadge(b.withinRate) : <span className="text-xs text-muted-foreground">—</span>}
                        </td>
                        <td className="px-4 py-1.5" />
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {ungraded.length > 0 && (
          <div className="border-t px-4 py-3 space-y-1">
            <p className="text-xs font-medium text-muted-foreground">Not graded yet — and saying so:</p>
            {ungraded.map((r) => (
              <p key={r.rail} className="text-xs text-muted-foreground">
                <span className="font-medium">{r.label}:</span> {r.why}
              </p>
            ))}
          </div>
        )}

        <p className="px-4 py-3 text-xs text-muted-foreground border-t">
          Every number above is computed from a recorded prediction AND a recorded outcome —
          settlement statements, scanned Closing Disclosures, sold prices, real head counts,
          human verdicts. Rails without outcome data say so instead of inventing accuracy.
        </p>
      </CardContent>
    </Card>
  )
}
