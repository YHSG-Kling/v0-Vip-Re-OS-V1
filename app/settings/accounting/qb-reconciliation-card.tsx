// app/settings/accounting/qb-reconciliation-card.tsx
// THE ONE reconciliation card (keep-one, like provider-connection-card): every
// accounting scope surface renders the QuickBooks reconciliation through this
// single presentational component. Server-renderable — pure props, no state.
//
// Honesty rules rendered here, not just claimed:
//   • QB_RECONCILIATION_HEADER (not a live QuickBooks pull) is always shown.
//   • Zero-row periods say "nothing to reconcile" — no fake 0% or 100%.
//   • log_based (brokerage) shows count-based coverage and no invented amounts.
//   • requires_migration / no_export_lane / error render the stated verdict.

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Scale } from "lucide-react"
import type { ScopeQbReconciliation } from "@/lib/finance/qb-reconciliation"

const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`

const STATUS_BADGE: Record<ScopeQbReconciliation["status"], { label: string; cls: string }> = {
  reconciled: { label: "Marker-based", cls: "bg-emerald-100 text-emerald-800 border-emerald-200" },
  log_based: { label: "Count-based", cls: "bg-sky-100 text-sky-800 border-sky-200" },
  not_connected: { label: "Not connected", cls: "bg-gray-100 text-gray-600 border-gray-200" },
  requires_migration: { label: "Requires migration", cls: "bg-amber-100 text-amber-800 border-amber-200" },
  no_export_lane: { label: "No export lane", cls: "bg-gray-100 text-gray-600 border-gray-200" },
  error: { label: "Unavailable", cls: "bg-red-100 text-red-700 border-red-200" },
}

export function QbReconciliationCard({ recon }: { recon: ScopeQbReconciliation }) {
  const t = recon.totals
  const badge = STATUS_BADGE[recon.status]
  const showNumbers = (recon.status === "reconciled" || recon.status === "log_based" || recon.status === "not_connected") && t.totalRows > 0
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2 flex-wrap">
          <Scale className="h-4 w-4" />
          QuickBooks reconciliation — {recon.periodLabel}
          <Badge variant="outline" className={`text-[11px] ${badge.cls}`}>{badge.label}</Badge>
        </CardTitle>
        {/* the standing honesty header (QB_RECONCILIATION_HEADER) — every surface states it */}
        <CardDescription>
          Reconciles OS ledgers ({recon.ledger}) against OS-recorded export markers only — not a live
          QuickBooks pull. Edits made inside QuickBooks itself are not visible here.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {showNumbers && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <ReconStat label="Export coverage" value={t.coveragePct === null ? "—" : `${t.coveragePct}%`} />
            <ReconStat label="Rows exported" value={`${t.exportedRows}/${t.totalRows}`} />
            <ReconStat
              label="Ledger total"
              value={usd(t.totalAmount)}
            />
            <ReconStat
              label="Exported total"
              value={t.exportedAmount === null ? "unknown" : usd(t.exportedAmount)}
              sub={t.exportedAmount === null ? "count-based lane" : t.unexportedAmount ? `${usd(t.unexportedAmount)} unexported` : undefined}
            />
          </div>
        )}
        <p className="text-xs text-muted-foreground">{recon.statement}</p>
        {t.unexported.length > 0 && (
          <div className="rounded-lg border p-3">
            <p className="text-xs font-medium mb-1.5">Unexported rows ({t.unexportedRows}{t.unexportedRows > t.unexported.length ? `, showing ${t.unexported.length}` : ""})</p>
            <ul className="space-y-1">
              {t.unexported.slice(0, 8).map((r) => (
                <li key={r.id} className="text-xs text-muted-foreground flex items-center justify-between gap-3">
                  <span className="truncate">{r.label}</span>
                  <span className="tabular-nums shrink-0">{usd(r.amount)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function ReconStat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border p-3">
      <p className="text-lg font-bold tabular-nums">{value}</p>
      <p className="text-[11px] text-muted-foreground">{label}</p>
      {sub && <p className="text-[10px] text-muted-foreground mt-0.5">{sub}</p>}
    </div>
  )
}
