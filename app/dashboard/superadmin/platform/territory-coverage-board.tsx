// app/dashboard/superadmin/platform/territory-coverage-board.tsx
// ─── TERRITORY COVERAGE BOARD (owner round 39, rec 2+3) ──────────────────────
// The platform's honest coverage map: a sortable state → zip TABLE (no map
// library — nothing is drawn the data can't back) over the same ground truth
// the scrape resolver runs on, plus the per-market scrape-ROI funnel with
// recorded-cost-only economics. Server-rendered, strictly read-only; data is
// loaded by the page (lib/analytics/territory-coverage + territory-roi).

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { MapPin, DollarSign, Archive } from "lucide-react"
import type { CoverageBoard } from "@/lib/analytics/territory-coverage"
import type { TerritoryRoiReport } from "@/lib/analytics/territory-roi"
import type { ParkedRetentionReport } from "@/lib/lead-pipeline/parked-retention"
import { purgeStaleParkedLeadsFormAction } from "@/app/actions/superadmin/parked-retention"

const pct = (r: number | null) => (r == null ? "—" : `${Math.round(r * 100)}%`)
const usd = (n: number | null) => (n == null ? null : `$${n.toFixed(2)}`)

export function TerritoryCoverageBoard({
  board,
  boardError,
  roi,
  roiError,
  retention = null,
  retentionError = null,
}: {
  board: CoverageBoard | null
  boardError: string | null
  roi: TerritoryRoiReport | null
  roiError: string | null
  /** Round 40 — the parked-lead retention posture (optional; omitted = card hidden). */
  retention?: ParkedRetentionReport | null
  retentionError?: string | null
}) {
  return (
    <div className="space-y-6">
      {/* ── Coverage: state → zip claim roster + window volume ── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <MapPin className="h-4 w-4 text-primary" />
            Territory coverage — claimed zips, lead volume, awaiting-subscriber
            {board && (
              <span className="ml-auto text-xs font-normal text-muted-foreground">
                last {board.windowDays}d · {board.totals.claimedZips} claimed zip{board.totals.claimedZips === 1 ? "" : "s"} · {board.totals.activeClaimants} active claimant{board.totals.activeClaimants === 1 ? "" : "s"}
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {!board ? (
            <p className="p-4 text-sm text-muted-foreground">
              Coverage unavailable{boardError ? ` — ${boardError}` : "."}
            </p>
          ) : board.zips.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">
              No active subscriber claims any zip yet, and no window lead volume exists — the honest empty board.
            </p>
          ) : (
            <>
              <div className="px-4 pt-3 pb-1 flex flex-wrap gap-2 text-xs">
                <Badge variant="outline" className="text-xs">{board.totals.unclaimedZipsWithVolume} unclaimed zip{board.totals.unclaimedZipsWithVolume === 1 ? "" : "s"} with volume</Badge>
                <Badge className={board.totals.awaitingSubscriberLeads > 0 ? "bg-amber-100 text-amber-800 text-xs" : "bg-slate-100 text-slate-700 text-xs"}>
                  {board.totals.awaitingSubscriberLeads} lead{board.totals.awaitingSubscriberLeads === 1 ? "" : "s"} awaiting a subscriber
                </Badge>
                <Badge variant="outline" className="text-xs">{board.totals.rawTotal} raw · {board.totals.promotedTotal} promoted</Badge>
                {board.totals.staleClaims > 0 && (
                  <Badge className="bg-slate-100 text-slate-700 text-xs">{board.totals.staleClaims} stale claim{board.totals.staleClaims === 1 ? "" : "s"} (non-active tenants, excluded)</Badge>
                )}
                {board.capped && <Badge className="bg-amber-100 text-amber-800 text-xs">read cap hit — counts are floors</Badge>}
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/10">
                      <th className="text-left px-4 py-2 font-medium text-muted-foreground">State</th>
                      <th className="text-left px-4 py-2 font-medium text-muted-foreground">Zip</th>
                      <th className="text-left px-4 py-2 font-medium text-muted-foreground">Claimed by (active subscribers)</th>
                      <th className="text-right px-4 py-2 font-medium text-muted-foreground" title="Raw scraped records normalized to this zip in the window">Raw</th>
                      <th className="text-right px-4 py-2 font-medium text-muted-foreground" title="Scrape-promoted leads (leads.raw_record_id set)">Promoted</th>
                      <th className="text-right px-4 py-2 font-medium text-muted-foreground" title="All leads in this zip in the window">Leads</th>
                      <th className="text-right px-4 py-2 font-medium text-muted-foreground" title="Promoted platform leads with no owning tenant (leads.brokerage_id IS NULL)">Awaiting</th>
                    </tr>
                  </thead>
                  <tbody>
                    {board.byState.map((group) =>
                      group.zips.map((z, i) => (
                        <tr key={`${group.state}-${z.zip}`} className="border-b last:border-0 hover:bg-muted/10">
                          <td className="px-4 py-2 text-xs text-muted-foreground">{i === 0 ? group.state : ""}</td>
                          <td className="px-4 py-2 font-mono text-xs">{z.zip}{z.city ? <span className="ml-2 font-sans text-muted-foreground">{z.city}</span> : null}</td>
                          <td className="px-4 py-2">
                            {z.claimedBy.length === 0 ? (
                              <Badge variant="outline" className="text-[10px] text-muted-foreground">unclaimed</Badge>
                            ) : (
                              <div className="flex flex-wrap gap-1">
                                {z.claimedBy.map((c) => (
                                  <Badge key={c.brokerageId} className="bg-emerald-100 text-emerald-800 text-[10px]">{c.name}</Badge>
                                ))}
                              </div>
                            )}
                          </td>
                          <td className="px-4 py-2 text-right tabular-nums text-xs">{z.rawCount || "—"}</td>
                          <td className="px-4 py-2 text-right tabular-nums text-xs">{z.promotedCount || "—"}</td>
                          <td className="px-4 py-2 text-right tabular-nums text-xs">{z.leadCount || "—"}</td>
                          <td className={`px-4 py-2 text-right tabular-nums text-xs ${z.awaitingSubscriber > 0 ? "text-amber-700 font-medium" : "text-muted-foreground"}`}>
                            {z.awaitingSubscriber || "—"}
                          </td>
                        </tr>
                      )),
                    )}
                  </tbody>
                </table>
              </div>
              <ul className="px-4 py-3 space-y-0.5">
                {board.honestNotes.map((n) => (
                  <li key={n} className="text-[11px] text-muted-foreground">· {n}</li>
                ))}
              </ul>
            </>
          )}
        </CardContent>
      </Card>

      {/* ── Scrape ROI per market: raw → promoted → contacts → first appts ── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <DollarSign className="h-4 w-4 text-primary" />
            Scrape ROI per territory — raw → promoted → contacts → first appointments
            {roi && (
              <span className="ml-auto text-xs font-normal text-muted-foreground">
                last {roi.windowDays}d · {roi.totals.marketsWithCost} of {roi.markets.length} market{roi.markets.length === 1 ? "" : "s"} with recorded cost
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {!roi ? (
            <p className="p-4 text-sm text-muted-foreground">
              ROI unavailable{roiError ? ` — ${roiError}` : "."}
            </p>
          ) : roi.markets.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">
              No scraping markets are configured yet — the funnel starts when a tenant sets up territories.
            </p>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/10">
                      <th className="text-left px-4 py-2 font-medium text-muted-foreground">Market</th>
                      <th className="text-right px-4 py-2 font-medium text-muted-foreground">Raw</th>
                      <th className="text-right px-4 py-2 font-medium text-muted-foreground" title="promoted / raw pulled">Promoted</th>
                      <th className="text-right px-4 py-2 font-medium text-muted-foreground" title="converted contacts / promoted">Contacts</th>
                      <th className="text-right px-4 py-2 font-medium text-muted-foreground" title="first appointments / converted contacts">1st appts</th>
                      <th className="text-right px-4 py-2 font-medium text-muted-foreground" title="Recorded provider spend only (vendor ledger) — never estimated">Cost</th>
                      <th className="text-right px-4 py-2 font-medium text-muted-foreground">$/promoted</th>
                    </tr>
                  </thead>
                  <tbody>
                    {roi.markets.map((m) => (
                      <tr key={m.marketId} className="border-b last:border-0 hover:bg-muted/10">
                        <td className="px-4 py-2">
                          <span className="font-medium">{m.label}</span>
                          {!m.isActive && <Badge variant="outline" className="ml-2 text-[10px]">inactive</Badge>}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums text-xs">{m.rawPulled}</td>
                        <td className="px-4 py-2 text-right tabular-nums text-xs">{m.promoted} <span className="text-muted-foreground">({pct(m.promotionRate)})</span></td>
                        <td className="px-4 py-2 text-right tabular-nums text-xs">{m.convertedContacts} <span className="text-muted-foreground">({pct(m.contactRate)})</span></td>
                        <td className="px-4 py-2 text-right tabular-nums text-xs">{m.firstAppointments} <span className="text-muted-foreground">({pct(m.appointmentRate)})</span></td>
                        <td className="px-4 py-2 text-right tabular-nums text-xs" title={m.costNote}>
                          {usd(m.costUsd) ?? <span className="text-muted-foreground italic">not recorded</span>}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums text-xs">{usd(m.costPerPromotedUsd) ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <ul className="px-4 py-3 space-y-0.5">
                {roi.honestNotes.map((n) => (
                  <li key={n} className="text-[11px] text-muted-foreground">· {n}</li>
                ))}
              </ul>
            </>
          )}
        </CardContent>
      </Card>

      {/* ── Parked-lead retention posture (round 40, rec 5) — the documented
             data-retention stance over the same brokerage_id-IS-NULL population
             the "Awaiting" column counts, plus the superadmin-only anonymized
             stale archival (PII purge, zip-level row retained). ── */}
      {(retention || retentionError) && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <Archive className="h-4 w-4 text-primary" />
              Parked-lead retention posture
              {retention && (
                <span className="ml-auto text-xs font-normal text-muted-foreground">
                  {retention.total} parked lead{retention.total === 1 ? "" : "s"} · {retention.purged} already anonymized
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {!retention ? (
              <p className="text-sm text-muted-foreground">
                Retention posture unavailable{retentionError ? ` — ${retentionError}` : "."}
              </p>
            ) : (
              <>
                <p className="text-xs text-muted-foreground">{retention.statement}</p>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  {(["fresh", "aging", "stale"] as const).map((tier) => (
                    <div key={tier} className={`border rounded p-3 ${tier === "stale" && retention.tiers.stale > 0 ? "border-amber-300 bg-amber-50/30" : ""}`}>
                      <div className="flex justify-between items-baseline">
                        <span className="text-xs font-medium uppercase text-muted-foreground">
                          {retention.posture[tier].label} <span className="normal-case font-normal">({retention.posture[tier].ageLabel})</span>
                        </span>
                        <span className="text-lg font-bold tabular-nums">{retention.tiers[tier]}</span>
                      </div>
                      <p className="text-[11px] text-muted-foreground mt-1">{retention.posture[tier].posture}</p>
                    </div>
                  ))}
                </div>
                {retention.stalePreview.count > 0 ? (
                  <div className="border rounded p-3 space-y-2">
                    <p className="text-xs font-medium">
                      Stale archival preview — exactly what a purge would touch:
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {retention.stalePreview.count} row{retention.stalePreview.count === 1 ? "" : "s"} anonymized (rows kept, PII removed) ·
                      purges {retention.stalePreview.columnsPurged.join(", ")} ·
                      retains {retention.stalePreview.columnsRetained.join(", ")} + purged_at marker
                    </p>
                    <div className="flex flex-wrap gap-1">
                      {retention.stalePreview.zips.slice(0, 24).map((z) => (
                        <Badge key={z.zip} variant="outline" className="text-[10px] font-mono">{z.zip} × {z.count}</Badge>
                      ))}
                      {retention.stalePreview.zips.length > 24 && (
                        <Badge variant="outline" className="text-[10px]">+{retention.stalePreview.zips.length - 24} more zips</Badge>
                      )}
                    </div>
                    <form action={purgeStaleParkedLeadsFormAction}>
                      <Button type="submit" size="sm" variant="outline" className="text-amber-800 border-amber-300">
                        <Archive className="h-3.5 w-3.5 mr-1.5" />
                        Anonymize {retention.stalePreview.count} stale parked lead{retention.stalePreview.count === 1 ? "" : "s"} (purge PII, keep zip rows)
                      </Button>
                    </form>
                    <p className="text-[11px] text-muted-foreground">
                      Superadmin-only; the action re-derives its target set server-side, anonymizes in place (never deletes rows), and writes the receipt (count + zips) to the superadmin audit ledger.
                    </p>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    No stale parked leads are eligible for archival right now — nothing to purge.
                  </p>
                )}
                <ul className="space-y-0.5">
                  {retention.honestNotes.map((n) => (
                    <li key={n} className="text-[11px] text-muted-foreground">· {n}</li>
                  ))}
                </ul>
              </>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
