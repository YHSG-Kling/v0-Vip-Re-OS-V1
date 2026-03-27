"use client"

import { useState } from "react"
import { runScrapeTestAction } from "@/app/actions/admin/run-scrape-test"

// ── Types ──────────────────────────────────────────────────────────────────────
interface Market {
  id: string
  name: string
  city: string | null
  state: string | null
  enabled_sources: string[] | null
  monthly_budget_usd: number | null
  spend_this_month: number | null
  is_active: boolean
  last_scraped_at: string | null
}

interface Execution {
  id: string
  scraper_type: string
  status: string
  started_at: string | null
  completed_at: string | null
  total_items_found: number | null
  leads_created: number | null
  api_cost: number | null
  error_message: string | null
}

interface FunnelRow {
  source: string
  processing_status: string
  count: number
}

export interface DiagnosticsData {
  markets:    Market[]
  executions: Execution[]
  funnel:     FunnelRow[]
}

interface DryRunResult {
  market:            { id: string; name: string; city: string; state: string; budget_used_pct: number | null }
  source:            string
  dry_run:           boolean
  territory_phrases: { buyerPhrases: string[]; sellerPhrases: string[] }
  preview_records:   Array<{ sourceRecordId: string; source: string; intentType: string; motivationScore: number; firstName?: string | null; lastName?: string | null; propertyAddress?: string | null }>
  would_insert:      number
  estimated_cost_usd: number
  error:             string | null
}

// ── Status badge ───────────────────────────────────────────────────────────────
function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    completed:  "bg-emerald-950 text-emerald-400 border border-emerald-800",
    running:    "bg-blue-950 text-blue-400 border border-blue-800",
    failed:     "bg-red-950 text-red-400 border border-red-800",
    pending:    "bg-zinc-800 text-zinc-400 border border-zinc-700",
    processing: "bg-amber-950 text-amber-400 border border-amber-800",
    promoted:   "bg-emerald-950 text-emerald-400 border border-emerald-800",
  }
  const cls = colors[status] ?? "bg-zinc-800 text-zinc-400 border border-zinc-700"
  return (
    <span className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-mono uppercase tracking-wide ${cls}`}>
      {status}
    </span>
  )
}

// ── Budget bar ─────────────────────────────────────────────────────────────────
function BudgetBar({ spent, budget }: { spent: number; budget: number }) {
  const pct     = budget > 0 ? Math.min(100, Math.round((spent / budget) * 100)) : 0
  const barColor = pct >= 90 ? "bg-red-500" : pct >= 70 ? "bg-amber-500" : "bg-blue-500"
  return (
    <div className="flex items-center gap-3">
      <div className="relative h-1.5 flex-1 rounded-full bg-zinc-800">
        <div className={`absolute left-0 top-0 h-full rounded-full ${barColor}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="w-24 text-right font-mono text-xs text-zinc-400">
        ${spent.toFixed(2)} / ${budget.toFixed(0)}
      </span>
    </div>
  )
}

// ── Main client component ──────────────────────────────────────────────────────
export function ScrapeDiagnosticsClient({ data }: { data: DiagnosticsData }) {
  const [selectedMarketId, setSelectedMarketId] = useState<string>(data.markets[0]?.id ?? "")
  const [selectedSource,   setSelectedSource]   = useState<string>("batchdata_motivated")
  const [dryRunResult,     setDryRunResult]      = useState<DryRunResult | null>(null)
  const [loading,          setLoading]           = useState(false)
  const [dryRunError,      setDryRunError]       = useState<string | null>(null)

  // Aggregate funnel by source
  const funnelBySource = data.funnel.reduce<Record<string, Record<string, number>>>((acc, row) => {
    if (!acc[row.source]) acc[row.source] = {}
    acc[row.source][row.processing_status] = (acc[row.source][row.processing_status] ?? 0) + row.count
    return acc
  }, {})

  const totalRaw      = data.funnel.reduce((s, r) => s + r.count, 0)
  const totalPromoted = data.funnel.filter(r => r.processing_status === "promoted").reduce((s, r) => s + r.count, 0)
  const totalFailed   = data.funnel.filter(r => r.processing_status === "failed").reduce((s, r) => s + r.count, 0)
  const totalPending  = data.funnel.filter(r => r.processing_status === "pending").reduce((s, r) => s + r.count, 0)

  const activeMarkets  = data.markets.filter(m => m.is_active).length
  const failedExec     = data.executions.filter(e => e.status === "failed").length
  const totalApiCost   = data.executions.reduce((s, e) => s + (e.api_cost ?? 0), 0)

  async function runDryTest() {
    if (!selectedMarketId) return
    setLoading(true)
    setDryRunError(null)
    setDryRunResult(null)
    try {
      // Server action keeps CRON_SECRET server-side — never exposed to the browser
      const result = await runScrapeTestAction(selectedMarketId, selectedSource)
      if (result.error) { setDryRunError(result.error); return }
      setDryRunResult(result as DryRunResult)
    } catch (err) {
      setDryRunError(String(err))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-[#ededed] font-sans">
      {/* Header */}
      <div className="border-b border-zinc-800 bg-[#0a0a0a] px-8 py-5">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs font-mono uppercase tracking-widest text-zinc-500">Kernel OS Admin</p>
            <h1 className="mt-0.5 text-xl font-semibold text-white">Scrape Diagnostics</h1>
          </div>
          <span className="rounded border border-zinc-700 bg-zinc-900 px-3 py-1 text-xs font-mono text-zinc-400">
            Production
          </span>
        </div>
      </div>

      <div className="mx-auto max-w-7xl space-y-8 px-8 py-8">

        {/* Stat cards */}
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          {[
            { label: "Active Territories", value: activeMarkets, sub: `${data.markets.length} total` },
            { label: "Raw Records",        value: totalRaw.toLocaleString(), sub: `${totalPending} pending` },
            { label: "Promoted Leads",     value: totalPromoted.toLocaleString(), sub: "to leads table" },
            { label: "Pipeline Errors",    value: totalFailed, sub: `${failedExec} exec failures` },
          ].map(card => (
            <div key={card.label} className="rounded-lg border border-zinc-800 bg-[#111] p-5">
              <p className="text-xs font-mono uppercase tracking-wide text-zinc-500">{card.label}</p>
              <p className="mt-2 text-3xl font-semibold tabular-nums text-white">{card.value}</p>
              <p className="mt-1 text-xs text-zinc-600">{card.sub}</p>
            </div>
          ))}
        </div>

        {/* Territory budgets */}
        <section>
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-widest text-zinc-500">Territory Budgets</h2>
          <div className="overflow-hidden rounded-lg border border-zinc-800 bg-[#111]">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-800 text-left text-xs font-mono uppercase tracking-wide text-zinc-500">
                  <th className="px-5 py-3">Territory</th>
                  <th className="px-5 py-3">Sources</th>
                  <th className="px-5 py-3 w-64">Budget</th>
                  <th className="px-5 py-3">Last Run</th>
                  <th className="px-5 py-3">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60">
                {data.markets.map(m => (
                  <tr key={m.id} className="hover:bg-zinc-900/40 transition-colors">
                    <td className="px-5 py-3 font-medium text-white">
                      {m.name}
                      <span className="ml-2 text-xs text-zinc-500">{m.city}, {m.state}</span>
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex flex-wrap gap-1">
                        {(m.enabled_sources ?? []).map(s => (
                          <span key={s} className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs font-mono text-zinc-400">
                            {s.replace(/_/g, ' ')}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="px-5 py-3">
                      {m.monthly_budget_usd ? (
                        <BudgetBar spent={m.spend_this_month ?? 0} budget={m.monthly_budget_usd} />
                      ) : (
                        <span className="text-xs text-zinc-600">no budget set</span>
                      )}
                    </td>
                    <td className="px-5 py-3 font-mono text-xs text-zinc-500">
                      {m.last_scraped_at
                        ? new Date(m.last_scraped_at).toLocaleString()
                        : "never"}
                    </td>
                    <td className="px-5 py-3">
                      <StatusBadge status={m.is_active ? "active" : "inactive"} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* Pipeline funnel by source */}
        <section>
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-widest text-zinc-500">Pipeline Funnel by Source</h2>
          <div className="overflow-hidden rounded-lg border border-zinc-800 bg-[#111]">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-800 text-left text-xs font-mono uppercase tracking-wide text-zinc-500">
                  <th className="px-5 py-3">Source</th>
                  <th className="px-5 py-3">Pending</th>
                  <th className="px-5 py-3">Processing</th>
                  <th className="px-5 py-3">Promoted</th>
                  <th className="px-5 py-3">Failed</th>
                  <th className="px-5 py-3">Other</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60">
                {Object.entries(funnelBySource).map(([src, counts]) => {
                  const other = Object.entries(counts)
                    .filter(([k]) => !["pending","processing","promoted","failed"].includes(k))
                    .reduce((s, [, v]) => s + v, 0)
                  return (
                    <tr key={src} className="hover:bg-zinc-900/40 transition-colors">
                      <td className="px-5 py-3 font-mono text-xs text-zinc-300">{src}</td>
                      <td className="px-5 py-3 tabular-nums text-zinc-400">{counts["pending"] ?? 0}</td>
                      <td className="px-5 py-3 tabular-nums text-zinc-400">{counts["processing"] ?? 0}</td>
                      <td className="px-5 py-3 tabular-nums text-emerald-400">{counts["promoted"] ?? 0}</td>
                      <td className="px-5 py-3 tabular-nums text-red-400">{counts["failed"] ?? 0}</td>
                      <td className="px-5 py-3 tabular-nums text-zinc-600">{other}</td>
                    </tr>
                  )
                })}
                {Object.keys(funnelBySource).length === 0 && (
                  <tr><td colSpan={6} className="px-5 py-8 text-center text-sm text-zinc-600">No pipeline data yet</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        {/* Recent executions */}
        <section>
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-widest text-zinc-500">Recent Executions</h2>
          <div className="overflow-hidden rounded-lg border border-zinc-800 bg-[#111]">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-800 text-left text-xs font-mono uppercase tracking-wide text-zinc-500">
                  <th className="px-5 py-3">Scraper</th>
                  <th className="px-5 py-3">Status</th>
                  <th className="px-5 py-3">Items Found</th>
                  <th className="px-5 py-3">Created</th>
                  <th className="px-5 py-3">API Cost</th>
                  <th className="px-5 py-3">Started</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60">
                {data.executions.map(e => (
                  <tr key={e.id} className="hover:bg-zinc-900/40 transition-colors">
                    <td className="px-5 py-3 font-mono text-xs text-zinc-300">{e.scraper_type}</td>
                    <td className="px-5 py-3"><StatusBadge status={e.status} /></td>
                    <td className="px-5 py-3 tabular-nums text-zinc-400">{e.total_items_found ?? "—"}</td>
                    <td className="px-5 py-3 tabular-nums text-zinc-400">{e.leads_created ?? "—"}</td>
                    <td className="px-5 py-3 font-mono text-xs text-zinc-500">
                      {e.api_cost != null ? `$${e.api_cost.toFixed(4)}` : "—"}
                    </td>
                    <td className="px-5 py-3 font-mono text-xs text-zinc-500">
                      {e.started_at ? new Date(e.started_at).toLocaleString() : "—"}
                    </td>
                  </tr>
                ))}
                {data.executions.length === 0 && (
                  <tr><td colSpan={6} className="px-5 py-8 text-center text-sm text-zinc-600">No executions recorded yet</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        {/* Dry-run preview */}
        <section>
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-widest text-zinc-500">Dry-Run Preview</h2>
          <div className="rounded-lg border border-zinc-800 bg-[#111] p-5">
            <div className="flex flex-wrap items-end gap-4">
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-mono text-zinc-500">Territory</label>
                <select
                  value={selectedMarketId}
                  onChange={e => setSelectedMarketId(e.target.value)}
                  className="rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
                >
                  {data.markets.map(m => (
                    <option key={m.id} value={m.id}>{m.name} — {m.city}, {m.state}</option>
                  ))}
                </select>
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-mono text-zinc-500">Source</label>
                <select
                  value={selectedSource}
                  onChange={e => setSelectedSource(e.target.value)}
                  className="rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
                >
                  <option value="batchdata_motivated">batchdata_motivated</option>
                  <option value="google_phrase_intent">google_phrase_intent</option>
                </select>
              </div>
              <button
                onClick={runDryTest}
                disabled={loading || !selectedMarketId}
                className="rounded border border-blue-700 bg-blue-950 px-4 py-2 text-sm font-medium text-blue-400 transition-colors hover:bg-blue-900 disabled:opacity-50"
              >
                {loading ? "Running..." : "Run Dry Test"}
              </button>
            </div>

            {dryRunError && (
              <div className="mt-4 rounded border border-red-800 bg-red-950 p-3 text-sm text-red-400">
                {dryRunError}
              </div>
            )}

            {dryRunResult && (
              <div className="mt-5 space-y-4">
                {/* Territory phrases */}
                <div>
                  <p className="mb-2 text-xs font-mono uppercase text-zinc-500">Territory Phrases</p>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <p className="mb-1 text-xs text-zinc-600">Seller ({dryRunResult.territory_phrases.sellerPhrases.length})</p>
                      <ul className="space-y-0.5">
                        {dryRunResult.territory_phrases.sellerPhrases.slice(0, 4).map(p => (
                          <li key={p} className="font-mono text-xs text-zinc-400">{p}</li>
                        ))}
                      </ul>
                    </div>
                    <div>
                      <p className="mb-1 text-xs text-zinc-600">Buyer ({dryRunResult.territory_phrases.buyerPhrases.length})</p>
                      <ul className="space-y-0.5">
                        {dryRunResult.territory_phrases.buyerPhrases.slice(0, 4).map(p => (
                          <li key={p} className="font-mono text-xs text-zinc-400">{p}</li>
                        ))}
                      </ul>
                    </div>
                  </div>
                </div>

                {/* Preview records */}
                <div>
                  <div className="mb-2 flex items-center gap-3">
                    <p className="text-xs font-mono uppercase text-zinc-500">
                      Preview Records — {dryRunResult.would_insert} would insert
                    </p>
                    <span className="font-mono text-xs text-zinc-600">
                      est. cost: ${dryRunResult.estimated_cost_usd.toFixed(4)}
                    </span>
                  </div>
                  {dryRunResult.preview_records.length > 0 ? (
                    <div className="overflow-hidden rounded border border-zinc-800">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="border-b border-zinc-800 text-left font-mono text-zinc-600">
                            <th className="px-4 py-2">ID</th>
                            <th className="px-4 py-2">Intent</th>
                            <th className="px-4 py-2">Score</th>
                            <th className="px-4 py-2">Name / Address</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-zinc-800/60">
                          {dryRunResult.preview_records.slice(0, 8).map(r => (
                            <tr key={r.sourceRecordId} className="hover:bg-zinc-900/40">
                              <td className="px-4 py-2 font-mono text-zinc-500 max-w-[140px] truncate">{r.sourceRecordId}</td>
                              <td className="px-4 py-2">
                                <StatusBadge status={r.intentType} />
                              </td>
                              <td className="px-4 py-2 tabular-nums text-zinc-400">{r.motivationScore}</td>
                              <td className="px-4 py-2 text-zinc-400">
                                {r.firstName && r.lastName
                                  ? `${r.firstName} ${r.lastName}`
                                  : r.propertyAddress ?? "—"}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="text-sm text-zinc-600">No viable records returned for this territory + source.</p>
                  )}
                </div>
              </div>
            )}
          </div>
        </section>

      </div>
    </div>
  )
}
