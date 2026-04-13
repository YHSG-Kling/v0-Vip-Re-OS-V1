'use client'

import { useEffect, useState, useTransition, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  getProviderRoiMetrics,
  providerMetricsToCsv,
} from '@/lib/analytics/vendor-roi'
import type { ProviderMetrics, ProviderTrendPoint, DateRange } from '@/lib/analytics/vendor-roi'
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts'

// ─── TYPES ────────────────────────────────────────────────────────────────────

type SortKey = keyof ProviderMetrics
type SortDir = 'asc' | 'desc'

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function fmt$(n: number) {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })
}
function fmtPct(n: number) {
  return (n * 100).toFixed(1) + '%'
}
function fmtNum(n: number, decimals = 1) {
  return n.toFixed(decimals)
}

// ─── PAGE ─────────────────────────────────────────────────────────────────────

export default function ProviderIntelligencePage() {
  const [brokerageId, setBrokerageId] = useState<string | null>(null)
  const [dateRange, setDateRange] = useState<DateRange>('30')
  const [providers, setProviders] = useState<ProviderMetrics[]>([])
  const [trendData, setTrendData] = useState<ProviderTrendPoint[]>([])
  const [generatedAt, setGeneratedAt] = useState<string | null>(null)
  const [sortKey, setSortKey] = useState<SortKey>('totalLeads')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  // ── Resolve brokerageId ──────────────────────────────────────────────────────
  useEffect(() => {
    const supabase = createClient()
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) return
      supabase
        .from('users')
        .select('brokerage_id')
        .eq('id', user.id)
        .single()
        .then(({ data }) => {
          if (data?.brokerage_id) setBrokerageId(data.brokerage_id)
        })
    })
  }, [])

  // ── Load metrics ─────────────────────────────────────────────────────────────
  const load = useCallback(() => {
    if (!brokerageId) return
    startTransition(async () => {
      try {
        const result = await getProviderRoiMetrics({ brokerageId, dateRangeDays: dateRange })
        setProviders(result.providers)
        setTrendData(result.trendData)
        setGeneratedAt(result.generatedAt)
        setError(null)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load metrics')
      }
    })
  }, [brokerageId, dateRange])

  useEffect(() => { load() }, [load])

  // ── Sort ─────────────────────────────────────────────────────────────────────
  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    } else {
      setSortKey(key)
      setSortDir('desc')
    }
  }

  const sorted = [...providers].sort((a, b) => {
    const av = a[sortKey]
    const bv = b[sortKey]
    if (av === null || av === undefined) return 1
    if (bv === null || bv === undefined) return -1
    if (typeof av === 'string') return sortDir === 'asc'
      ? av.localeCompare(bv as string)
      : (bv as string).localeCompare(av)
    return sortDir === 'asc' ? (av as number) - (bv as number) : (bv as number) - (av as number)
  })

  // ── Export CSV ───────────────────────────────────────────────────────────────
  const handleExport = () => {
    const csv = providerMetricsToCsv(providers)
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `provider-roi-${dateRange}d-${new Date().toISOString().substring(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  // ── Bar chart data: cost per lead by provider ────────────────────────────────
  const barData = providers.map(p => ({
    name: p.providerName,
    'Cost / Lead': parseFloat(p.costPerLead.toFixed(2)),
    'Cost / Qualified Lead': parseFloat(p.costPerQualifiedLead.toFixed(2)),
  }))

  // ── Line chart: unique providers in trend ────────────────────────────────────
  const trendProviders = Array.from(new Set(trendData.map(d => d.providerName)))
  const TREND_COLORS = ['#2563eb', '#16a34a', '#d97706', '#dc2626', '#7c3aed', '#0891b2']

  // Group trend by date for recharts
  const trendByDate = new Map<string, Record<string, number>>()
  for (const pt of trendData) {
    if (!trendByDate.has(pt.date)) trendByDate.set(pt.date, { date: pt.date as unknown as number })
    trendByDate.get(pt.date)![pt.providerName] = parseFloat(pt.avgScore.toFixed(1))
  }
  const lineData = Array.from(trendByDate.values()).sort((a, b) =>
    String(a.date).localeCompare(String(b.date))
  )

  // ── Sort indicator ───────────────────────────────────────────────────────────
  const sortIcon = (key: SortKey) => {
    if (sortKey !== key) return <span className="text-foreground/30 ml-1">↕</span>
    return <span className="ml-1">{sortDir === 'asc' ? '↑' : '↓'}</span>
  }

  const thClass = 'px-3 py-2 text-left text-xs font-semibold text-foreground/60 uppercase tracking-wide cursor-pointer select-none hover:text-foreground whitespace-nowrap'
  const tdClass = 'px-3 py-2 text-sm text-foreground whitespace-nowrap'

  return (
    <main className="min-h-screen bg-background text-foreground font-sans">
      <div className="max-w-7xl mx-auto px-4 py-8">

        {/* Header */}
        <div className="flex items-start justify-between gap-4 mb-8">
          <div>
            <h1 className="text-2xl font-bold text-foreground">Lead Provider Intelligence</h1>
            <p className="text-sm text-foreground/60 mt-1">
              ROI analysis per lead source. All ROI figures are{' '}
              <span className="font-semibold">Est.</span> (estimated, not guaranteed).
            </p>
          </div>
          <div className="flex items-center gap-3 flex-shrink-0">
            {/* Date range */}
            <div className="flex rounded-md border border-border overflow-hidden text-sm">
              {(['30', '60', '90'] as DateRange[]).map(d => (
                <button
                  key={d}
                  onClick={() => setDateRange(d)}
                  className={`px-3 py-1.5 transition-colors ${
                    dateRange === d
                      ? 'bg-primary text-primary-foreground font-medium'
                      : 'bg-card text-foreground/70 hover:bg-muted'
                  }`}
                >
                  {d}d
                </button>
              ))}
            </div>
            <button
              onClick={handleExport}
              disabled={providers.length === 0}
              className="px-4 py-1.5 rounded-md border border-border bg-card text-sm font-medium hover:bg-muted disabled:opacity-40 transition-colors"
            >
              Export CSV
            </button>
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="mb-6 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {/* Loading */}
        {isPending && (
          <div className="text-sm text-foreground/50 mb-4 animate-pulse">Loading metrics...</div>
        )}

        {/* Empty state */}
        {!isPending && providers.length === 0 && !error && (
          <div className="text-center py-16 text-foreground/40 text-sm">
            No lead data found for the selected period.
          </div>
        )}

        {providers.length > 0 && (
          <>
            {/* ── CHARTS ROW ─────────────────────────────────────────────── */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">

              {/* Bar: cost per lead */}
              <div className="rounded-xl border border-border bg-card p-5">
                <h2 className="text-sm font-semibold text-foreground mb-4">
                  Cost per Lead by Provider
                </h2>
                <ResponsiveContainer width="100%" height={240}>
                  <BarChart data={barData} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                    <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                    <YAxis tickFormatter={v => `$${v}`} tick={{ fontSize: 11 }} />
                    <Tooltip formatter={(v: number) => fmt$(v)} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Bar dataKey="Cost / Lead" fill="#2563eb" radius={[4, 4, 0, 0]} />
                    <Bar dataKey="Cost / Qualified Lead" fill="#16a34a" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>

              {/* Line: lead quality over time */}
              <div className="rounded-xl border border-border bg-card p-5">
                <h2 className="text-sm font-semibold text-foreground mb-4">
                  Avg Lead Score Over Time (by Provider)
                </h2>
                <ResponsiveContainer width="100%" height={240}>
                  <LineChart data={lineData} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                    <XAxis dataKey="date" tick={{ fontSize: 10 }} />
                    <YAxis domain={[0, 100]} tick={{ fontSize: 11 }} />
                    <Tooltip />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    {trendProviders.map((p, i) => (
                      <Line
                        key={p}
                        type="monotone"
                        dataKey={p}
                        stroke={TREND_COLORS[i % TREND_COLORS.length]}
                        dot={false}
                        strokeWidth={2}
                      />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* ── COMPARISON TABLE ───────────────────────────────────────── */}
            <div className="rounded-xl border border-border bg-card overflow-hidden">
              <div className="px-5 py-4 border-b border-border flex items-center justify-between">
                <h2 className="text-sm font-semibold text-foreground">Provider Comparison</h2>
                {generatedAt && (
                  <span className="text-xs text-foreground/40">
                    Updated {new Date(generatedAt).toLocaleTimeString()}
                  </span>
                )}
              </div>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-muted/50 border-b border-border">
                    <tr>
                      {([
                        ['providerName',         'Provider'],
                        ['totalLeads',           'Leads'],
                        ['leadsQualified',       'Qualified'],
                        ['conversionRate',       'Conv. Rate'],
                        ['totalSpend',           'Total Spend'],
                        ['costPerLead',          'Cost / Lead'],
                        ['costPerQualifiedLead', 'Cost / Qual. Lead'],
                        ['estRoi',               'Est. ROI'],
                        ['avgLeadScore',         'Avg Score'],
                        ['avgDaysToQualify',     'Avg Days to Qualify'],
                      ] as [SortKey, string][]).map(([key, label]) => (
                        <th key={key} className={thClass} onClick={() => handleSort(key)}>
                          {label}{sortIcon(key)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {sorted.map(p => (
                      <tr key={p.providerName} className="hover:bg-muted/30 transition-colors">
                        <td className={`${tdClass} font-medium`}>{p.providerName}</td>
                        <td className={tdClass}>{p.totalLeads.toLocaleString()}</td>
                        <td className={tdClass}>{p.leadsQualified.toLocaleString()}</td>
                        <td className={tdClass}>{fmtPct(p.conversionRate)}</td>
                        <td className={tdClass}>{fmt$(p.totalSpend)}</td>
                        <td className={tdClass}>{fmt$(p.costPerLead)}</td>
                        <td className={tdClass}>{fmt$(p.costPerQualifiedLead)}</td>
                        <td className={tdClass}>
                          <span className={p.estRoi >= 0 ? 'text-green-600' : 'text-red-500'}>
                            {fmtPct(p.estRoi)} <span className="text-foreground/40 text-xs">Est.</span>
                          </span>
                        </td>
                        <td className={tdClass}>{fmtNum(p.avgLeadScore)}</td>
                        <td className={tdClass}>
                          {p.avgDaysToQualify !== null ? fmtNum(p.avgDaysToQualify) : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </div>
    </main>
  )
}
