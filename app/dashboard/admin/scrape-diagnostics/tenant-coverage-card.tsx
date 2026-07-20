// app/dashboard/admin/scrape-diagnostics/tenant-coverage-card.tsx
// ─── "YOUR COVERAGE" (owner round 39, rec 2+3 — tenant card) ─────────────────
// The tenant's view of the territory coverage map, mounted on the brokerage
// lead-scraping surface: their markets, their claimed zips with real window
// volume, their own scrape funnel (raw → promoted → contacts → 1st appts,
// recorded cost only), and SAME-STATE unclaimed zips with real platform-lead
// volume as honest expansion hints (no adjacency math exists — the label says
// exactly what these are). Server-rendered, read-only; styled to the dark
// diagnostics theme it sits on. No map library — a table, not a fake map.

import type { TenantCoverage } from "@/lib/analytics/territory-coverage"
import type { TerritoryRoiReport } from "@/lib/analytics/territory-roi"

const pct = (r: number | null) => (r == null ? "—" : `${Math.round(r * 100)}%`)
const usd = (n: number | null) => (n == null ? null : `$${n.toFixed(2)}`)

export function TenantCoverageCard({
  coverage,
  coverageError,
  roi,
  roiError,
}: {
  coverage: TenantCoverage | null
  coverageError: string | null
  roi: TerritoryRoiReport | null
  roiError: string | null
}) {
  return (
    <div className="bg-[#0a0a0a] pb-12 text-[#ededed] font-sans">
      <div className="mx-auto max-w-7xl px-8">
        <div className="rounded-lg border border-zinc-800 bg-[#111]">
          <div className="border-b border-zinc-800 px-5 py-4">
            <p className="text-xs font-mono uppercase tracking-wide text-zinc-500">Territory coverage</p>
            <h2 className="mt-0.5 text-lg font-semibold text-white">Your coverage</h2>
            {coverage && (
              <p className="mt-1 text-xs text-zinc-500">
                {coverage.markets.length} market{coverage.markets.length === 1 ? "" : "s"} · {coverage.totals.claimedZips} claimed zip{coverage.totals.claimedZips === 1 ? "" : "s"} · {coverage.totals.rawCount} raw / {coverage.totals.promotedCount} promoted / {coverage.totals.leadCount} leads in the window
              </p>
            )}
          </div>

          {!coverage ? (
            <p className="px-5 py-4 text-sm text-zinc-500">
              Coverage unavailable{coverageError ? ` — ${coverageError}` : "."}
            </p>
          ) : (
            <div className="px-5 py-4 space-y-6">
              {/* Markets */}
              <div>
                <p className="text-xs font-mono uppercase tracking-wide text-zinc-500 mb-2">Your markets</p>
                {coverage.markets.length === 0 ? (
                  <p className="text-sm text-zinc-500">No scraping markets configured yet — set up a territory to start receiving scraped leads.</p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {coverage.markets.map((m) => (
                      <span key={m.id} className={`rounded border px-2 py-1 text-xs ${m.is_active ? "border-emerald-900 bg-emerald-950/40 text-emerald-400" : "border-zinc-700 bg-zinc-900 text-zinc-500"}`}>
                        {m.name?.trim() || [m.city, m.state].filter(Boolean).join(", ") || m.id.slice(0, 8)}
                        {!m.is_active && " (inactive)"}
                        {m.zip_codes && m.zip_codes.length > 0 && <span className="ml-1 text-zinc-500">· {m.zip_codes.length} zips</span>}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {/* Claimed zips + volume */}
              <div>
                <p className="text-xs font-mono uppercase tracking-wide text-zinc-500 mb-2">Your claimed zips — window volume</p>
                {coverage.claimedZips.length === 0 ? (
                  <p className="text-sm text-zinc-500">No zip claims on the roster yet — saving a market with zip codes syncs your service-area claims.</p>
                ) : (
                  <div className="overflow-x-auto rounded border border-zinc-800">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-zinc-800 bg-zinc-900/60 text-left">
                          <th className="px-3 py-2 text-xs font-medium text-zinc-500">State</th>
                          <th className="px-3 py-2 text-xs font-medium text-zinc-500">Zip</th>
                          <th className="px-3 py-2 text-right text-xs font-medium text-zinc-500">Raw</th>
                          <th className="px-3 py-2 text-right text-xs font-medium text-zinc-500">Promoted</th>
                          <th className="px-3 py-2 text-right text-xs font-medium text-zinc-500">Leads</th>
                        </tr>
                      </thead>
                      <tbody>
                        {coverage.claimedZips.map((z) => (
                          <tr key={z.zip} className="border-b border-zinc-900 last:border-0">
                            <td className="px-3 py-2 text-xs text-zinc-500">{z.state}</td>
                            <td className="px-3 py-2 font-mono text-xs text-zinc-300">{z.zip}{z.city ? <span className="ml-2 font-sans text-zinc-600">{z.city}</span> : null}</td>
                            <td className="px-3 py-2 text-right text-xs tabular-nums text-zinc-400">{z.rawCount || "—"}</td>
                            <td className="px-3 py-2 text-right text-xs tabular-nums text-zinc-400">{z.promotedCount || "—"}</td>
                            <td className="px-3 py-2 text-right text-xs tabular-nums text-zinc-400">{z.leadCount || "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* Your scrape funnel */}
              <div>
                <p className="text-xs font-mono uppercase tracking-wide text-zinc-500 mb-2">Your scrape funnel — raw → promoted → contacts → first appointments</p>
                {!roi ? (
                  <p className="text-sm text-zinc-500">Funnel unavailable{roiError ? ` — ${roiError}` : "."}</p>
                ) : roi.markets.length === 0 ? (
                  <p className="text-sm text-zinc-500">No markets — no funnel to grade yet.</p>
                ) : (
                  <div className="overflow-x-auto rounded border border-zinc-800">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-zinc-800 bg-zinc-900/60 text-left">
                          <th className="px-3 py-2 text-xs font-medium text-zinc-500">Market</th>
                          <th className="px-3 py-2 text-right text-xs font-medium text-zinc-500">Raw</th>
                          <th className="px-3 py-2 text-right text-xs font-medium text-zinc-500">Promoted</th>
                          <th className="px-3 py-2 text-right text-xs font-medium text-zinc-500">Contacts</th>
                          <th className="px-3 py-2 text-right text-xs font-medium text-zinc-500">1st appts</th>
                          <th className="px-3 py-2 text-right text-xs font-medium text-zinc-500">Cost</th>
                          <th className="px-3 py-2 text-right text-xs font-medium text-zinc-500">$/promoted</th>
                        </tr>
                      </thead>
                      <tbody>
                        {roi.markets.map((m) => (
                          <tr key={m.marketId} className="border-b border-zinc-900 last:border-0">
                            <td className="px-3 py-2 text-xs text-zinc-300">{m.label}{!m.isActive && <span className="ml-1 text-zinc-600">(inactive)</span>}</td>
                            <td className="px-3 py-2 text-right text-xs tabular-nums text-zinc-400">{m.rawPulled}</td>
                            <td className="px-3 py-2 text-right text-xs tabular-nums text-zinc-400">{m.promoted} <span className="text-zinc-600">({pct(m.promotionRate)})</span></td>
                            <td className="px-3 py-2 text-right text-xs tabular-nums text-zinc-400">{m.convertedContacts} <span className="text-zinc-600">({pct(m.contactRate)})</span></td>
                            <td className="px-3 py-2 text-right text-xs tabular-nums text-zinc-400">{m.firstAppointments} <span className="text-zinc-600">({pct(m.appointmentRate)})</span></td>
                            <td className="px-3 py-2 text-right text-xs tabular-nums text-zinc-400" title={m.costNote}>
                              {usd(m.costUsd) ?? <span className="italic text-zinc-600">not recorded</span>}
                            </td>
                            <td className="px-3 py-2 text-right text-xs tabular-nums text-zinc-400">{usd(m.costPerPromotedUsd) ?? "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* Expansion hints */}
              <div>
                <p className="text-xs font-mono uppercase tracking-wide text-zinc-500 mb-2">Expansion hints — same-state unclaimed zips with real platform-lead volume</p>
                {coverage.expansionHints.length === 0 ? (
                  <p className="text-sm text-zinc-500">
                    None right now — no unclaimed zip in your states produced platform leads in the window. Hints only ever show zips with real observed volume.
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {coverage.expansionHints.map((z) => (
                      <span key={z.zip} className="rounded border border-blue-900 bg-blue-950/40 px-2 py-1 text-xs text-blue-300">
                        {z.zip} <span className="text-zinc-500">{z.state}{z.city ? ` · ${z.city}` : ""}</span>
                        <span className="ml-1 text-blue-400">{z.platformLeadCount} platform lead{z.platformLeadCount === 1 ? "" : "s"}</span>
                      </span>
                    ))}
                  </div>
                )}
              </div>

              <ul className="space-y-0.5">
                {coverage.honestNotes.map((n) => (
                  <li key={n} className="text-[11px] text-zinc-600">· {n}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
