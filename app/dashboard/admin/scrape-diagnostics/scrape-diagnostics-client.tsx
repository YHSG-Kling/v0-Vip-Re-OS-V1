"use client"

import { useState, useTransition } from "react"
import { runScrapeTestAction } from "@/app/actions/admin/run-scrape-test"
import { retryFailedSourceBatch } from "@/lib/kernel/scraping"
import type { ScrapingDiagnosticsData } from "@/lib/kernel/scraping"

// ─── Sub-component types ──────────────────────────────────────────────────────
interface DryRunResult {
  market:             { id: string; name: string; city: string; state: string; budget_used_pct: number | null }
  source:             string
  dry_run:            boolean
  territory_phrases:  { buyerPhrases: string[]; sellerPhrases: string[] }
  preview_records:    Array<{ sourceRecordId: string; source: string; intentType: string; motivationScore: number; firstName?: string | null; lastName?: string | null; propertyAddress?: string | null }>
  would_insert:       number
  estimated_cost_usd: number
  error:              string | null
}

// ─── Shared primitives ────────────────────────────────────────────────────────
function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    completed:                            "bg-emerald-950 text-emerald-400 border border-emerald-800",
    running:                              "bg-blue-950 text-blue-400 border border-blue-800",
    failed:                               "bg-red-950 text-red-400 border border-red-800",
    error:                                "bg-red-950 text-red-400 border border-red-800",
    pending:                              "bg-zinc-800 text-zinc-400 border border-zinc-700",
    processing:                           "bg-amber-950 text-amber-400 border border-amber-800",
    promoted:                             "bg-emerald-950 text-emerald-400 border border-emerald-800",
    enriching:                            "bg-indigo-950 text-indigo-400 border border-indigo-800",
    queued_for_enrichment:               "bg-indigo-950 text-indigo-400 border border-indigo-800",
    territory_mismatch:                   "bg-orange-950 text-orange-400 border border-orange-800",
    insufficient_identity:               "bg-red-950 text-red-400 border border-red-800",
    insufficient_identity_for_promotion: "bg-red-950 text-red-400 border border-red-800",
    duplicate_pre_enrich:                "bg-zinc-800 text-zinc-400 border border-zinc-700",
    duplicate_post_enrich:               "bg-zinc-800 text-zinc-400 border border-zinc-700",
    skipped:                              "bg-zinc-800 text-zinc-400 border border-zinc-700",
    created:                              "bg-emerald-950 text-emerald-400 border border-emerald-800",
    merged:                               "bg-blue-950 text-blue-400 border border-blue-800",
    active:                               "bg-emerald-950 text-emerald-400 border border-emerald-800",
    inactive:                             "bg-zinc-800 text-zinc-400 border border-zinc-700",
    alive:                                "bg-emerald-950 text-emerald-400 border border-emerald-800",
    dead:                                 "bg-red-950 text-red-400 border border-red-800",
    buyer:                                "bg-blue-950 text-blue-400 border border-blue-800",
    seller:                               "bg-amber-950 text-amber-400 border border-amber-800",
    unknown:                              "bg-zinc-800 text-zinc-400 border border-zinc-700",
  }
  const cls = map[status] ?? "bg-zinc-800 text-zinc-400 border border-zinc-700"
  return (
    <span className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-mono uppercase tracking-wide ${cls}`}>
      {status.replace(/_/g, " ")}
    </span>
  )
}

function BudgetBar({ spent, budget }: { spent: number; budget: number }) {
  const pct       = budget > 0 ? Math.min(100, Math.round((spent / budget) * 100)) : 0
  const barColor  = pct >= 90 ? "bg-red-500" : pct >= 70 ? "bg-amber-500" : "bg-blue-500"
  return (
    <div className="flex items-center gap-3">
      <div className="relative h-1.5 flex-1 rounded-full bg-zinc-800">
        <div className={`absolute left-0 top-0 h-full rounded-full ${barColor}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="w-24 text-right font-mono text-xs text-zinc-400">${spent.toFixed(2)} / ${budget.toFixed(0)}</span>
    </div>
  )
}

function SectionHeader({ title, count }: { title: string; count?: number }) {
  return (
    <div className="flex items-center gap-3 mb-4">
      <h2 className="text-sm font-semibold uppercase tracking-widest text-zinc-500">{title}</h2>
      {count !== undefined && (
        <span className="rounded bg-zinc-800 px-2 py-0.5 text-xs font-mono text-zinc-400">{count}</span>
      )}
    </div>
  )
}

function TableContainer({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-lg border border-zinc-800 bg-[#111]">
      <div className="overflow-x-auto">{children}</div>
    </div>
  )
}

function TH({ children }: { children: React.ReactNode }) {
  return <th className="px-4 py-3 text-left text-xs font-mono uppercase tracking-wide text-zinc-500">{children}</th>
}

function TD({ children, mono }: { children: React.ReactNode; mono?: boolean }) {
  return (
    <td className={`px-4 py-3 ${mono ? "font-mono text-xs text-zinc-400" : "text-sm text-zinc-300"}`}>
      {children}
    </td>
  )
}

// ─── Tab IDs ──────────────────────────────────────────────────────────────────
type Tab = "overview" | "funnel" | "dedup" | "gating" | "cron" | "failed" | "dryrun"

const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Territories" },
  { id: "funnel",   label: "Pipeline Funnel" },
  { id: "dedup",    label: "Dedup Decisions" },
  { id: "gating",   label: "Gating Status" },
  { id: "cron",     label: "Cron History" },
  { id: "failed",   label: "Failed Batches" },
  { id: "dryrun",   label: "Dry Run" },
]

// ─── Main client component ────────────────────────────────────────────────────
export function ScrapeDiagnosticsClient({
  data,
  actorHealth,
  isSuperadmin,
  currentUserId,
}: {
  data: ScrapingDiagnosticsData
  actorHealth: Array<{ id: string; task: string; actor_id: string; alive: boolean; last_checked: string | null; last_error: string | null }>
  isSuperadmin: boolean
  currentUserId: string
}) {
  const [activeTab,       setActiveTab]       = useState<Tab>("overview")
  const [selectedMarketId, setSelectedMarketId] = useState(data.markets[0]?.id ?? "")
  const [selectedSource,  setSelectedSource]  = useState("batchdata_motivated")
  const [dryRunResult,    setDryRunResult]    = useState<DryRunResult | null>(null)
  const [dryRunError,     setDryRunError]     = useState<string | null>(null)
  const [dryRunLoading,   setDryRunLoading]   = useState(false)
  const [retryingId,      setRetryingId]      = useState<string | null>(null)
  const [retryMessages,   setRetryMessages]   = useState<Record<string, string>>({})
  const [isPending,       startTransition]    = useTransition()

  // ── Aggregations ────────────────────────────────────────────────────────────
  const totalRaw       = data.funnel.reduce((s, r) => s + r.count, 0)
  const totalPromoted  = data.funnel.filter(r => r.processing_status === "promoted").reduce((s, r) => s + r.count, 0)
  const totalFailed    = data.funnel.filter(r => r.processing_status === "failed" || r.processing_status === "error").reduce((s, r) => s + r.count, 0)
  const totalPending   = data.funnel.filter(r => r.processing_status === "pending").reduce((s, r) => s + r.count, 0)
  const totalEnriching = data.funnel.filter(r => ["enriching","queued_for_enrichment"].includes(r.processing_status)).reduce((s, r) => s + r.count, 0)

  const activeMarkets   = data.markets.filter(m => m.is_active).length
  const cronLastStatus  = data.cronHistory[0]?.status ?? "—"
  const cronLastRun     = data.cronHistory[0]?.started_at
    ? new Date(data.cronHistory[0].started_at).toLocaleString()
    : "Never"

  const funnelBySource = data.funnel.reduce<Record<string, Record<string, number>>>((acc, row) => {
    if (!acc[row.source]) acc[row.source] = {}
    acc[row.source][row.processing_status] = (acc[row.source][row.processing_status] ?? 0) + row.count
    return acc
  }, {})

  // ── Actions ─────────────────────────────────────────────────────────────────
  async function handleDryRun() {
    if (!selectedMarketId) return
    setDryRunLoading(true)
    setDryRunError(null)
    setDryRunResult(null)
    try {
      const result = await runScrapeTestAction(selectedMarketId, selectedSource)
      if (result.error) { setDryRunError(result.error); return }
      setDryRunResult(result as DryRunResult)
    } catch (err) {
      setDryRunError(String(err))
    } finally {
      setDryRunLoading(false)
    }
  }

  async function handleRetryBatch(executionId: string, brokerageId: string) {
    setRetryingId(executionId)
    setRetryMessages(prev => ({ ...prev, [executionId]: "" }))
    try {
      const result = await retryFailedSourceBatch({
        executionId,
        brokerageId,
        retriedByUserId: currentUserId,
      })
      setRetryMessages(prev => ({
        ...prev,
        [executionId]: result.success
          ? `Requeued ${result.rawRecordsRequeued} records`
          : `Error: ${result.error}`,
      }))
    } catch (err) {
      setRetryMessages(prev => ({ ...prev, [executionId]: `Error: ${String(err)}` }))
    } finally {
      setRetryingId(null)
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
            <p className="mt-1 text-xs text-zinc-600">
              Last cron: {cronLastRun} &nbsp;&mdash;&nbsp; <StatusBadge status={cronLastStatus} />
            </p>
          </div>
          <span className="rounded border border-zinc-700 bg-zinc-900 px-3 py-1 text-xs font-mono text-zinc-400">
            {isSuperadmin ? "Superadmin · All Brokerages" : "Production"}
          </span>
        </div>
      </div>

      {/* Stat cards */}
      <div className="mx-auto max-w-7xl px-8 pt-8">
        <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
          {[
            { label: "Active Territories",  value: activeMarkets,              sub: `${data.markets.length} total` },
            { label: "Raw Records",         value: totalRaw.toLocaleString(),   sub: `${totalPending} pending` },
            { label: "Enriching",           value: totalEnriching.toLocaleString(), sub: "queued or active" },
            { label: "Promoted Leads",      value: totalPromoted.toLocaleString(), sub: "to leads table" },
            { label: "Failed / Gated",      value: (totalFailed + data.gatingDecisions.length).toLocaleString(), sub: `${data.failedBatches.length} failed batches` },
          ].map(card => (
            <div key={card.label} className="rounded-lg border border-zinc-800 bg-[#111] p-5">
              <p className="text-xs font-mono uppercase tracking-wide text-zinc-500">{card.label}</p>
              <p className="mt-2 text-3xl font-semibold tabular-nums text-white">{card.value}</p>
              <p className="mt-1 text-xs text-zinc-600">{card.sub}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Tabs */}
      <div className="mx-auto max-w-7xl px-8 pt-8">
        <div className="flex gap-1 border-b border-zinc-800 mb-8">
          {TABS.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-4 py-2 text-sm font-medium transition-colors ${
                activeTab === tab.id
                  ? "border-b-2 border-blue-500 text-white"
                  : "text-zinc-500 hover:text-zinc-300"
              }`}
            >
              {tab.label}
              {tab.id === "failed" && data.failedBatches.length > 0 && (
                <span className="ml-2 rounded bg-red-950 px-1.5 py-0.5 text-xs text-red-400">
                  {data.failedBatches.length}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* TAB: Territories */}
        {activeTab === "overview" && (
          <section>
            <SectionHeader title="Territory Budgets &amp; Source Health" count={data.markets.length} />
            <TableContainer>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-zinc-800">
                    <TH>Territory</TH>
                    <TH>Sources</TH>
                    <TH>Budget</TH>
                    <TH>Last Run</TH>
                    <TH>Status</TH>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800/60">
                  {data.markets.map(m => (
                    <tr key={m.id} className="hover:bg-zinc-900/40 transition-colors">
                      <TD>
                        <span className="font-medium text-white">{m.name}</span>
                        <span className="ml-2 text-xs text-zinc-500">{m.city}, {m.state}</span>
                      </TD>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-1">
                          {(m.enabled_sources ?? []).map(s => (
                            <span key={s} className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs font-mono text-zinc-400">{s.replace(/_/g, " ")}</span>
                          ))}
                        </div>
                      </td>
                      <td className="px-4 py-3 w-52">
                        {m.monthly_budget_usd
                          ? <BudgetBar spent={m.spend_this_month ?? 0} budget={m.monthly_budget_usd} />
                          : <span className="text-xs text-zinc-600">no budget set</span>}
                      </td>
                      <TD mono>
                        {m.last_scraped_at ? new Date(m.last_scraped_at).toLocaleString() : "never"}
                      </TD>
                      <td className="px-4 py-3">
                        <StatusBadge status={m.is_active ? "active" : "inactive"} />
                      </td>
                    </tr>
                  ))}
                  {data.markets.length === 0 && (
                    <tr><td colSpan={5} className="px-4 py-8 text-center text-sm text-zinc-600">No territories configured</td></tr>
                  )}
                </tbody>
              </table>
            </TableContainer>

            {/* Source execution health */}
            <div className="mt-8">
              <SectionHeader title="Recent Source Executions" count={data.executions.length} />
              <TableContainer>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-zinc-800">
                      <TH>Scraper</TH>
                      <TH>Status</TH>
                      <TH>Items Found</TH>
                      <TH>Created</TH>
                      <TH>API Cost</TH>
                      <TH>Started</TH>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800/60">
                    {data.executions.map(e => (
                      <tr key={e.id} className="hover:bg-zinc-900/40 transition-colors">
                        <TD mono>{e.scraper_type}</TD>
                        <td className="px-4 py-3"><StatusBadge status={e.status} /></td>
                        <TD mono>{e.total_items_found ?? "—"}</TD>
                        <TD mono>{e.leads_created ?? "—"}</TD>
                        <TD mono>{e.api_cost != null ? `$${e.api_cost.toFixed(4)}` : "—"}</TD>
                        <TD mono>{e.started_at ? new Date(e.started_at).toLocaleString() : "—"}</TD>
                      </tr>
                    ))}
                    {data.executions.length === 0 && (
                      <tr><td colSpan={6} className="px-4 py-8 text-center text-sm text-zinc-600">No executions recorded yet</td></tr>
                    )}
                  </tbody>
                </table>
              </TableContainer>
            </div>

            {/* Apify actor health — written by /api/cron/actor-health */}
            <div className="mt-8">
              <SectionHeader title="Actor Health" count={actorHealth.length} />
              <TableContainer>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-zinc-800">
                      <TH>Actor</TH>
                      <TH>Task</TH>
                      <TH>Status</TH>
                      <TH>Last Checked</TH>
                      <TH>Last Error</TH>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800/60">
                    {actorHealth.map(a => (
                      <tr key={a.id} className="hover:bg-zinc-900/40 transition-colors">
                        <TD mono>{a.actor_id}</TD>
                        <TD mono>{a.task}</TD>
                        <td className="px-4 py-3"><StatusBadge status={a.alive ? "alive" : "dead"} /></td>
                        <TD mono>{a.last_checked ? new Date(a.last_checked).toLocaleString() : "—"}</TD>
                        <td className="px-4 py-3 text-xs text-zinc-500 max-w-xs truncate">{a.last_error ?? "—"}</td>
                      </tr>
                    ))}
                    {actorHealth.length === 0 && (
                      <tr><td colSpan={5} className="px-4 py-8 text-center text-sm text-zinc-600">No actor health checks recorded yet</td></tr>
                    )}
                  </tbody>
                </table>
              </TableContainer>
            </div>
          </section>
        )}

        {/* TAB: Pipeline Funnel */}
        {activeTab === "funnel" && (
          <section>
            <SectionHeader title="Pipeline Funnel by Source" />
            <TableContainer>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-zinc-800">
                    <TH>Source</TH>
                    <TH>Pending</TH>
                    <TH>Enriching</TH>
                    <TH>Promoted</TH>
                    <TH>Duplicate</TH>
                    <TH>Failed / Error</TH>
                    <TH>Gated</TH>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800/60">
                  {Object.entries(funnelBySource).map(([src, counts]) => {
                    const enriching  = (counts["enriching"] ?? 0) + (counts["queued_for_enrichment"] ?? 0)
                    const failed     = (counts["failed"] ?? 0) + (counts["error"] ?? 0)
                    const duplicate  = (counts["duplicate_pre_enrich"] ?? 0) + (counts["duplicate_post_enrich"] ?? 0)
                    const gated      = (counts["territory_mismatch"] ?? 0) + (counts["insufficient_identity"] ?? 0) + (counts["insufficient_identity_for_promotion"] ?? 0)
                    return (
                      <tr key={src} className="hover:bg-zinc-900/40 transition-colors">
                        <TD mono>{src}</TD>
                        <td className="px-4 py-3 tabular-nums text-zinc-400">{counts["pending"] ?? 0}</td>
                        <td className="px-4 py-3 tabular-nums text-indigo-400">{enriching}</td>
                        <td className="px-4 py-3 tabular-nums text-emerald-400">{counts["promoted"] ?? 0}</td>
                        <td className="px-4 py-3 tabular-nums text-zinc-500">{duplicate}</td>
                        <td className="px-4 py-3 tabular-nums text-red-400">{failed}</td>
                        <td className="px-4 py-3 tabular-nums text-orange-400">{gated}</td>
                      </tr>
                    )
                  })}
                  {Object.keys(funnelBySource).length === 0 && (
                    <tr><td colSpan={7} className="px-4 py-8 text-center text-sm text-zinc-600">No pipeline data yet</td></tr>
                  )}
                </tbody>
              </table>
            </TableContainer>
          </section>
        )}

        {/* TAB: Dedup Decisions */}
        {activeTab === "dedup" && (
          <section>
            <SectionHeader title="Dedup Decisions" count={data.dedupDecisions.length} />
            <p className="mb-4 text-xs text-zinc-600">
              Records matched against existing leads and contacts via email, phone, and name+location.
              Action taken determines whether the raw record was skipped or merged.
            </p>
            <TableContainer>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-zinc-800">
                    <TH>Raw Record ID</TH>
                    <TH>Stage</TH>
                    <TH>Action</TH>
                    <TH>Skip Reason</TH>
                    <TH>Match Score</TH>
                    <TH>Old Confidence</TH>
                    <TH>New Confidence</TH>
                    <TH>At</TH>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800/60">
                  {data.dedupDecisions.map(d => (
                    <tr key={d.id} className="hover:bg-zinc-900/40 transition-colors">
                      <TD mono>{d.raw_record_id?.slice(0, 8) ?? "—"}</TD>
                      <TD mono>{d.stage ?? "—"}</TD>
                      <td className="px-4 py-3"><StatusBadge status={d.action_taken ?? "unknown"} /></td>
                      <td className="px-4 py-3 text-xs text-zinc-500 max-w-xs truncate">{d.skip_reason ?? "—"}</td>
                      <TD mono>{d.match_score != null ? d.match_score.toFixed(2) : "—"}</TD>
                      <TD mono>{d.old_enrichment_confidence != null ? d.old_enrichment_confidence.toFixed(2) : "—"}</TD>
                      <TD mono>{d.new_enrichment_confidence != null ? d.new_enrichment_confidence.toFixed(2) : "—"}</TD>
                      <TD mono>{new Date(d.created_at).toLocaleString()}</TD>
                    </tr>
                  ))}
                  {data.dedupDecisions.length === 0 && (
                    <tr><td colSpan={8} className="px-4 py-8 text-center text-sm text-zinc-600">No dedup decisions recorded yet</td></tr>
                  )}
                </tbody>
              </table>
            </TableContainer>
          </section>
        )}

        {/* TAB: Gating Status */}
        {activeTab === "gating" && (
          <section>
            <SectionHeader title="Gating Decisions" count={data.gatingDecisions.length} />
            <p className="mb-4 text-xs text-zinc-600">
              Raw records that failed viability gating. These records were NOT enriched or promoted.
              Territory mismatch and insufficient identity are the two gate types.
            </p>
            <TableContainer>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-zinc-800">
                    <TH>Record ID</TH>
                    <TH>Source</TH>
                    <TH>Gate Decision</TH>
                    <TH>Error Detail</TH>
                    <TH>At</TH>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800/60">
                  {data.gatingDecisions.map(g => (
                    <tr key={g.id} className="hover:bg-zinc-900/40 transition-colors">
                      <TD mono>{g.id.slice(0, 8)}</TD>
                      <TD mono>{g.source}</TD>
                      <td className="px-4 py-3"><StatusBadge status={g.processing_status} /></td>
                      <td className="px-4 py-3 text-xs text-zinc-500 max-w-xs truncate">{g.error_message ?? "—"}</td>
                      <TD mono>{new Date(g.created_at).toLocaleString()}</TD>
                    </tr>
                  ))}
                  {data.gatingDecisions.length === 0 && (
                    <tr><td colSpan={5} className="px-4 py-8 text-center text-sm text-zinc-600">No gating decisions recorded</td></tr>
                  )}
                </tbody>
              </table>
            </TableContainer>
          </section>
        )}

        {/* TAB: Cron History */}
        {activeTab === "cron" && (
          <section>
            <SectionHeader title="Cron Run History" count={data.cronHistory.length} />
            <p className="mb-4 text-xs text-zinc-600">
              Each row is one execution of the lead-scraping cron job.
              Duration, records processed, and error messages are written by the kernel on every run.
            </p>
            <TableContainer>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-zinc-800">
                    <TH>Job</TH>
                    <TH>Status</TH>
                    <TH>Duration</TH>
                    <TH>Records Processed</TH>
                    <TH>Error</TH>
                    <TH>Started</TH>
                    <TH>Completed</TH>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800/60">
                  {data.cronHistory.map(c => (
                    <tr key={c.id} className="hover:bg-zinc-900/40 transition-colors">
                      <TD mono>{c.cron_name}</TD>
                      <td className="px-4 py-3"><StatusBadge status={c.status} /></td>
                      <TD mono>{c.duration_ms != null ? `${(c.duration_ms / 1000).toFixed(1)}s` : "—"}</TD>
                      <TD mono>{c.records_processed ?? "—"}</TD>
                      <td className="px-4 py-3 text-xs text-red-400 max-w-xs truncate">{c.error_message ?? "—"}</td>
                      <TD mono>{new Date(c.started_at).toLocaleString()}</TD>
                      <TD mono>{c.completed_at ? new Date(c.completed_at).toLocaleString() : "—"}</TD>
                    </tr>
                  ))}
                  {data.cronHistory.length === 0 && (
                    <tr><td colSpan={7} className="px-4 py-8 text-center text-sm text-zinc-600">No cron runs recorded yet. Cron logs are written by the kernel on every scheduled execution.</td></tr>
                  )}
                </tbody>
              </table>
            </TableContainer>
          </section>
        )}

        {/* TAB: Failed Batches + Retry */}
        {activeTab === "failed" && (
          <section>
            <SectionHeader title="Failed Source Batches" count={data.failedBatches.length} />
            <p className="mb-4 text-xs text-zinc-600">
              Failed scraper executions. Retrying resets all associated error raw records to
              &lsquo;pending&rsquo; so the pipeline processor can reprocess them.
              AI ISA is never queued for raw records — only for promoted leads.
            </p>
            <TableContainer>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-zinc-800">
                    <TH>Scraper</TH>
                    <TH>Status</TH>
                    <TH>Items</TH>
                    <TH>Error</TH>
                    <TH>Started</TH>
                    <TH>Action</TH>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800/60">
                  {data.failedBatches.map(batch => (
                    <tr key={batch.id} className="hover:bg-zinc-900/40 transition-colors">
                      <TD mono>{batch.scraper_type}</TD>
                      <td className="px-4 py-3"><StatusBadge status={batch.status} /></td>
                      <TD mono>{batch.total_items_found ?? "—"}</TD>
                      <td className="px-4 py-3 text-xs text-red-400 max-w-xs truncate">{batch.error_message ?? "—"}</td>
                      <TD mono>{batch.started_at ? new Date(batch.started_at).toLocaleString() : "—"}</TD>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => handleRetryBatch(batch.id, batch.brokerage_id)}
                            disabled={retryingId === batch.id}
                            className="rounded border border-amber-700 bg-amber-950 px-3 py-1.5 text-xs font-medium text-amber-400 transition-colors hover:bg-amber-900 disabled:opacity-50"
                          >
                            {retryingId === batch.id ? "Retrying..." : "Retry Batch"}
                          </button>
                          {retryMessages[batch.id] && (
                            <span className={`text-xs ${retryMessages[batch.id].startsWith("Error") ? "text-red-400" : "text-emerald-400"}`}>
                              {retryMessages[batch.id]}
                            </span>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                  {data.failedBatches.length === 0 && (
                    <tr><td colSpan={6} className="px-4 py-8 text-center text-sm text-zinc-600">No failed batches</td></tr>
                  )}
                </tbody>
              </table>
            </TableContainer>
          </section>
        )}

        {/* TAB: Dry Run */}
        {activeTab === "dryrun" && (
          <section>
            <SectionHeader title="Dry-Run Preview" />
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
                    <option value="zillow_behavior">zillow_behavior</option>
                    <option value="social_intent">social_intent</option>
                  </select>
                </div>
                <button
                  onClick={handleDryRun}
                  disabled={dryRunLoading || !selectedMarketId}
                  className="rounded border border-blue-700 bg-blue-950 px-4 py-2 text-sm font-medium text-blue-400 transition-colors hover:bg-blue-900 disabled:opacity-50"
                >
                  {dryRunLoading ? "Running..." : "Run Dry Test"}
                </button>
              </div>

              {dryRunError && (
                <div className="mt-4 rounded border border-red-800 bg-red-950 p-3 text-sm text-red-400">{dryRunError}</div>
              )}

              {dryRunResult && (
                <div className="mt-5 space-y-5">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <p className="mb-2 text-xs font-mono uppercase text-zinc-500">Seller Phrases ({dryRunResult.territory_phrases.sellerPhrases.length})</p>
                      <ul className="space-y-0.5">
                        {dryRunResult.territory_phrases.sellerPhrases.slice(0, 5).map(p => (
                          <li key={p} className="font-mono text-xs text-zinc-400">{p}</li>
                        ))}
                      </ul>
                    </div>
                    <div>
                      <p className="mb-2 text-xs font-mono uppercase text-zinc-500">Buyer Phrases ({dryRunResult.territory_phrases.buyerPhrases.length})</p>
                      <ul className="space-y-0.5">
                        {dryRunResult.territory_phrases.buyerPhrases.slice(0, 5).map(p => (
                          <li key={p} className="font-mono text-xs text-zinc-400">{p}</li>
                        ))}
                      </ul>
                    </div>
                  </div>

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
                      <TableContainer>
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="border-b border-zinc-800">
                              <TH>ID</TH>
                              <TH>Intent</TH>
                              <TH>Score</TH>
                              <TH>Name / Address</TH>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-zinc-800/60">
                            {dryRunResult.preview_records.slice(0, 10).map(r => (
                              <tr key={r.sourceRecordId} className="hover:bg-zinc-900/40">
                                <td className="px-4 py-2 font-mono text-zinc-500 max-w-[140px] truncate">{r.sourceRecordId}</td>
                                <td className="px-4 py-2"><StatusBadge status={r.intentType} /></td>
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
                      </TableContainer>
                    ) : (
                      <p className="text-sm text-zinc-600">No viable records returned for this territory + source.</p>
                    )}
                  </div>
                </div>
              )}
            </div>
          </section>
        )}

        <div className="pb-12" />
      </div>
    </div>
  )
}
