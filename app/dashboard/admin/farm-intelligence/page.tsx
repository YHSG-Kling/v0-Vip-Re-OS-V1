"use client"

import { useEffect, useState, useTransition } from "react"
import { createClient } from "@/lib/supabase/client"
import { seedTerritoriesFromServiceArea, setFarmTerritoryMode } from "@/lib/territory/metrics-aggregator"

// ─── TYPES ────────────────────────────────────────────────────────────────────

type TerritoryMode = "use_settings" | "custom" | null

type MetricRow = {
  zip_code: string
  lead_count: number
  qualified_lead_count: number
  conversion_rate: number
  avg_score: number
  roi: number
  agent_saturation: number
  total_cost: number
  metric_date: string
}

type FarmTerritory = {
  id: string
  name: string
  zip_codes: string[]
  is_active: boolean
  marketing_budget_monthly: number
  agent_id: string | null
}

type TrendRow = {
  metric_date: string
  zip_code: string
  lead_count: number
}

// ─── PAGE ─────────────────────────────────────────────────────────────────────

export default function FarmIntelligencePage() {
  const supabase = createClient()

  const [brokerageId, setBrokerageId] = useState<string | null>(null)
  const [mode, setMode] = useState<TerritoryMode>(null)
  const [metrics, setMetrics] = useState<MetricRow[]>([])
  const [territories, setTerritories] = useState<FarmTerritory[]>([])
  const [trend, setTrend] = useState<TrendRow[]>([])
  const [selectedZip, setSelectedZip] = useState<string | null>(null)
  const [filterAgent, setFilterAgent] = useState("")
  const [filterTerritory, setFilterTerritory] = useState("")
  const [showTerritoryModal, setShowTerritoryModal] = useState(false)
  const [editTerritory, setEditTerritory] = useState<FarmTerritory | null>(null)
  const [mergeChoice, setMergeChoice] = useState<"keep" | "merge" | "overwrite" | null>(null)
  const [isPending, startTransition] = useTransition()
  const [loading, setLoading] = useState(true)
  const [metricKey, setMetricKey] = useState<keyof MetricRow>("lead_count")

  // New territory form state
  const [newName, setNewName] = useState("")
  const [newZips, setNewZips] = useState("")
  const [newBudget, setNewBudget] = useState("0")

  useEffect(() => { void load() }, [])

  async function load() {
    setLoading(true)
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) { setLoading(false); return }

    const { data: profile } = await supabase
      .from("user_profiles")
      .select("brokerage_id")
      .eq("id", user.id)
      .maybeSingle()

    const bid = profile?.brokerage_id as string | null
    if (!bid) { setLoading(false); return }
    setBrokerageId(bid)

    // Load territory mode from global_settings
    const { data: gs } = await supabase
      .from("global_settings")
      .select("additional_settings")
      .eq("brokerage_id", bid)
      .maybeSingle()

    const addl = (gs?.additional_settings ?? {}) as Record<string, unknown>
    const savedMode = (addl.farm_territory_mode as TerritoryMode) ?? null
    setMode(savedMode)

    // Load latest metrics (most recent date per zip)
    const today = new Date().toISOString().split("T")[0]
    const { data: metricsData } = await supabase
      .from("territory_metrics")
      .select("zip_code,lead_count,qualified_lead_count,conversion_rate,avg_score,roi,agent_saturation,total_cost,metric_date")
      .eq("brokerage_id", bid)
      .lte("metric_date", today)
      .order("metric_date", { ascending: false })
      .limit(500)

    // Deduplicate: keep latest row per zip
    const seen = new Set<string>()
    const latest: MetricRow[] = []
    for (const row of (metricsData ?? []) as MetricRow[]) {
      if (!seen.has(row.zip_code)) {
        seen.add(row.zip_code)
        latest.push(row)
      }
    }
    setMetrics(latest)

    // Load 30-day trend
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0]
    const { data: trendData } = await supabase
      .from("territory_metrics")
      .select("metric_date,zip_code,lead_count")
      .eq("brokerage_id", bid)
      .gte("metric_date", thirtyDaysAgo)
      .order("metric_date", { ascending: true })
    setTrend((trendData ?? []) as TrendRow[])

    // Load farm territories
    const { data: terrData } = await supabase
      .from("farm_territories")
      .select("id,name,zip_codes,is_active,marketing_budget_monthly,agent_id")
      .eq("brokerage_id", bid)
      .order("name")
    setTerritories((terrData ?? []) as FarmTerritory[])

    setLoading(false)
  }

  async function handleChooseMode(chosen: "use_settings" | "custom") {
    if (!brokerageId) return
    startTransition(async () => {
      if (chosen === "use_settings") {
        // If territories already exist, we need merge choice
        if (territories.length > 0 && mergeChoice === null) {
          setMergeChoice("keep") // prompt will show
          return
        }
        if (mergeChoice === "overwrite") {
          await supabase.from("farm_territories").delete().eq("brokerage_id", brokerageId)
        }
        await seedTerritoriesFromServiceArea(brokerageId)
      }
      await setFarmTerritoryMode(brokerageId, chosen)
      setMode(chosen)
      setMergeChoice(null)
      await load()
    })
  }

  async function handleSaveTerritory() {
    if (!brokerageId || !newName.trim()) return
    const zipList = newZips.split(/[\s,]+/).map((z) => z.trim()).filter(Boolean)

    if (editTerritory) {
      await supabase
        .from("farm_territories")
        .update({ name: newName, zip_codes: zipList, marketing_budget_monthly: parseFloat(newBudget) || 0 })
        .eq("id", editTerritory.id)
    } else {
      // Check for duplicate by (brokerage_id, name)
      const { data: dup } = await supabase
        .from("farm_territories")
        .select("id")
        .eq("brokerage_id", brokerageId)
        .eq("name", newName)
        .maybeSingle()
      if (dup) { alert("A territory with this name already exists."); return }

      await supabase.from("farm_territories").insert({
        brokerage_id: brokerageId,
        name: newName,
        zip_codes: zipList,
        marketing_budget_monthly: parseFloat(newBudget) || 0,
        is_active: true,
      })
    }
    setShowTerritoryModal(false)
    setEditTerritory(null)
    setNewName(""); setNewZips(""); setNewBudget("0")
    await load()
  }

  async function handleToggleTerritory(t: FarmTerritory) {
    await supabase.from("farm_territories").update({ is_active: !t.is_active }).eq("id", t.id)
    await load()
  }

  // Filter metrics by territory zip list if filter selected
  const filteredMetrics = metrics.filter((m) => {
    if (filterTerritory) {
      const terr = territories.find((t) => t.id === filterTerritory)
      if (terr && terr.zip_codes.length > 0 && !terr.zip_codes.includes(m.zip_code)) return false
    }
    return true
  })

  // 30-day trend for selected zip
  const trendForZip = selectedZip
    ? trend.filter((t) => t.zip_code === selectedZip)
    : []

  const metricLabels: Record<string, string> = {
    lead_count: "Lead Count",
    qualified_lead_count: "Qualified Leads",
    conversion_rate: "Conversion Rate",
    avg_score: "Avg Score",
    roi: "Est. ROI",
    agent_saturation: "Agent Saturation",
    total_cost: "Total Cost",
  }

  // Color scale for choropleth-style table
  function colorForValue(val: number, max: number): string {
    if (max === 0) return "bg-muted"
    const pct = Math.min(val / max, 1)
    if (pct > 0.66) return "bg-emerald-100 dark:bg-emerald-900/30"
    if (pct > 0.33) return "bg-yellow-100 dark:bg-yellow-900/30"
    return "bg-red-100 dark:bg-red-900/30"
  }

  const maxVal = Math.max(...filteredMetrics.map((m) => (m[metricKey] as number) ?? 0), 1)

  if (loading) {
    return (
      <main className="flex items-center justify-center min-h-screen">
        <p className="text-muted-foreground text-sm">Loading Farm Intelligence...</p>
      </main>
    )
  }

  // ── First-visit mode chooser ──────────────────────────────────────────────
  if (mode === null) {
    return (
      <main className="max-w-2xl mx-auto mt-24 px-6 font-sans">
        <h1 className="text-2xl font-bold text-foreground mb-2">Farm Intelligence</h1>
        <p className="text-muted-foreground text-sm mb-8">
          Choose how Farm Territories are sourced. This can be changed later in Settings.
        </p>

        <div className="grid gap-4">
          {/* Option 1 */}
          <button
            onClick={() => handleChooseMode("use_settings")}
            disabled={isPending}
            className="text-left border border-border rounded-xl p-6 hover:border-primary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <div className="flex items-start justify-between">
              <div>
                <p className="font-semibold text-foreground">Use existing service-area territories</p>
                <p className="text-sm text-muted-foreground mt-1">
                  Pre-fill territories from your brokerage service-area settings and start aggregating metrics immediately. Recommended.
                </p>
              </div>
              <span className="ml-4 shrink-0 text-xs font-medium bg-primary text-primary-foreground rounded-full px-2 py-0.5">Recommended</span>
            </div>
          </button>

          {/* Option 2 */}
          <button
            onClick={() => handleChooseMode("custom")}
            disabled={isPending}
            className="text-left border border-border rounded-xl p-6 hover:border-primary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <p className="font-semibold text-foreground">Customize farm territories</p>
            <p className="text-sm text-muted-foreground mt-1">
              Manually create and edit farm territories. Note: this is a marketing overlay and does not change service-area eligibility or lead routing.
            </p>
          </button>
        </div>

        {/* Merge choice modal (shown if territories already exist) */}
        {territories.length > 0 && mergeChoice !== null && (
          <div className="mt-8 border border-amber-300 bg-amber-50 dark:bg-amber-900/20 rounded-xl p-6">
            <p className="font-semibold text-amber-800 dark:text-amber-200 text-sm mb-3">
              {territories.length} existing farm territories found. How would you like to proceed?
            </p>
            <div className="flex gap-3 flex-wrap">
              <button
                onClick={() => { setMergeChoice("keep"); void handleChooseMode("use_settings") }}
                className="px-4 py-2 rounded-lg border border-border text-sm hover:bg-muted"
              >Keep Existing</button>
              <button
                onClick={() => { setMergeChoice("merge"); void handleChooseMode("use_settings") }}
                className="px-4 py-2 rounded-lg border border-border text-sm hover:bg-muted"
              >Merge Service Area</button>
              <button
                onClick={() => { setMergeChoice("overwrite"); void handleChooseMode("use_settings") }}
                className="px-4 py-2 rounded-lg bg-destructive text-destructive-foreground text-sm hover:opacity-90"
              >Overwrite With Service Area</button>
            </div>
          </div>
        )}
      </main>
    )
  }

  // ── Main dashboard ────────────────────────────────────────────────────────
  return (
    <main className="max-w-7xl mx-auto px-6 py-8 font-sans">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Farm Intelligence</h1>
          <p className="text-sm text-muted-foreground">Nightly territory metrics by zip code</p>
        </div>
        <div className="flex items-center gap-3">
          {mode === "custom" && (
            <button
              onClick={() => { setEditTerritory(null); setNewName(""); setNewZips(""); setNewBudget("0"); setShowTerritoryModal(true) }}
              className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:opacity-90"
            >
              + Add Territory
            </button>
          )}
          <button
            onClick={() => { setMode(null) }}
            className="px-3 py-2 rounded-lg border border-border text-sm text-muted-foreground hover:bg-muted"
          >
            Change Mode
          </button>
        </div>
      </div>

      {/* Custom mode banner */}
      {mode === "custom" && (
        <div className="mb-4 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 px-4 py-3 text-sm text-amber-800 dark:text-amber-200">
          This does not change service-area eligibility — it only changes farm marketing overlays.
        </div>
      )}

      {/* Filters */}
      <div className="flex gap-3 mb-6 flex-wrap">
        <select
          value={metricKey}
          onChange={(e) => setMetricKey(e.target.value as keyof MetricRow)}
          className="px-3 py-2 rounded-lg border border-border bg-background text-sm text-foreground"
        >
          {Object.entries(metricLabels).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
        <select
          value={filterTerritory}
          onChange={(e) => setFilterTerritory(e.target.value)}
          className="px-3 py-2 rounded-lg border border-border bg-background text-sm text-foreground"
        >
          <option value="">All Territories</option>
          {territories.map((t) => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
        </select>
      </div>

      {/* Two-column layout: choropleth table + sidebar */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Choropleth table (2/3 width) */}
        <div className="lg:col-span-2">
          <div className="rounded-xl border border-border overflow-hidden">
            <div className="bg-muted/40 px-4 py-3 border-b border-border">
              <p className="text-sm font-medium text-foreground">
                {metricLabels[metricKey]} by Zip Code
                {metricKey === "roi" && <span className="ml-2 text-xs text-muted-foreground">(Est. — not guaranteed)</span>}
              </p>
            </div>
            {filteredMetrics.length === 0 ? (
              <div className="px-4 py-12 text-center text-sm text-muted-foreground">
                No metrics yet. The nightly cron runs at 2:00 AM UTC.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-muted-foreground text-xs">
                      <th className="text-left px-4 py-2">Zip Code</th>
                      <th className="text-right px-4 py-2">{metricLabels[metricKey]}</th>
                      <th className="text-right px-4 py-2">Leads</th>
                      <th className="text-right px-4 py-2">Conv. Rate</th>
                      <th className="text-right px-4 py-2">Avg Score</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredMetrics.map((m) => (
                      <tr
                        key={m.zip_code}
                        onClick={() => setSelectedZip(selectedZip === m.zip_code ? null : m.zip_code)}
                        className={`border-b border-border cursor-pointer transition-colors ${
                          selectedZip === m.zip_code ? "bg-primary/10" : "hover:bg-muted/30"
                        }`}
                      >
                        <td className="px-4 py-2 font-mono font-medium text-foreground">{m.zip_code}</td>
                        <td className={`px-4 py-2 text-right font-medium rounded-sm ${colorForValue((m[metricKey] as number) ?? 0, maxVal)}`}>
                          {metricKey === "conversion_rate" || metricKey === "agent_saturation"
                            ? `${(((m[metricKey] as number) ?? 0) * 100).toFixed(1)}%`
                            : metricKey === "roi"
                            ? `${(((m[metricKey] as number) ?? 0) * 100).toFixed(0)}%`
                            : metricKey === "total_cost" || metricKey === "cost_per_lead"
                            ? `$${((m[metricKey] as number) ?? 0).toFixed(2)}`
                            : ((m[metricKey] as number) ?? 0).toFixed(1)}
                        </td>
                        <td className="px-4 py-2 text-right text-muted-foreground">{m.lead_count}</td>
                        <td className="px-4 py-2 text-right text-muted-foreground">{(m.conversion_rate * 100).toFixed(1)}%</td>
                        <td className="px-4 py-2 text-right text-muted-foreground">{m.avg_score.toFixed(0)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* 30-day trend for selected zip */}
          {selectedZip && trendForZip.length > 0 && (
            <div className="mt-4 rounded-xl border border-border p-4">
              <p className="text-sm font-medium text-foreground mb-3">30-Day Trend — {selectedZip}</p>
              <div className="flex items-end gap-1 h-24">
                {trendForZip.map((t) => {
                  const maxTrend = Math.max(...trendForZip.map((r) => r.lead_count), 1)
                  const height = Math.max((t.lead_count / maxTrend) * 100, 4)
                  return (
                    <div key={t.metric_date} className="flex flex-col items-center gap-1 flex-1 min-w-0">
                      <div
                        className="w-full bg-primary rounded-sm"
                        style={{ height: `${height}%` }}
                        title={`${t.metric_date}: ${t.lead_count} leads`}
                      />
                    </div>
                  )
                })}
              </div>
              <div className="flex justify-between text-xs text-muted-foreground mt-1">
                <span>{trendForZip[0]?.metric_date}</span>
                <span>{trendForZip[trendForZip.length - 1]?.metric_date}</span>
              </div>
            </div>
          )}
        </div>

        {/* Farm Territory sidebar (1/3 width) */}
        <div className="space-y-3">
          <p className="text-sm font-medium text-foreground">Farm Territories</p>
          {territories.length === 0 ? (
            <p className="text-xs text-muted-foreground">No territories defined.</p>
          ) : (
            territories.map((t) => (
              <div key={t.id} className="rounded-xl border border-border p-4 bg-background">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">{t.name}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {t.zip_codes.length > 0 ? t.zip_codes.slice(0, 4).join(", ") + (t.zip_codes.length > 4 ? ` +${t.zip_codes.length - 4}` : "") : "No zips"}
                    </p>
                    {t.marketing_budget_monthly > 0 && (
                      <p className="text-xs text-muted-foreground">${t.marketing_budget_monthly.toLocaleString()}/mo</p>
                    )}
                  </div>
                  <div className="flex flex-col gap-1 shrink-0">
                    <button
                      onClick={() => handleToggleTerritory(t)}
                      className={`text-xs px-2 py-0.5 rounded-full border ${t.is_active ? "border-emerald-400 text-emerald-700 dark:text-emerald-300" : "border-border text-muted-foreground"}`}
                    >
                      {t.is_active ? "Active" : "Inactive"}
                    </button>
                    {mode === "custom" && (
                      <button
                        onClick={() => {
                          setEditTerritory(t)
                          setNewName(t.name)
                          setNewZips(t.zip_codes.join(", "))
                          setNewBudget(String(t.marketing_budget_monthly ?? 0))
                          setShowTerritoryModal(true)
                        }}
                        className="text-xs text-primary hover:underline"
                      >
                        Edit
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Territory create/edit modal */}
      {showTerritoryModal && mode === "custom" && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-background rounded-2xl shadow-xl p-6 w-full max-w-md">
            <h2 className="text-lg font-semibold text-foreground mb-4">
              {editTerritory ? "Edit Territory" : "Add Farm Territory"}
            </h2>
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">Territory Name</label>
                <input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="e.g. North District"
                  className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm text-foreground"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">Zip Codes (comma or space separated)</label>
                <textarea
                  value={newZips}
                  onChange={(e) => setNewZips(e.target.value)}
                  rows={3}
                  placeholder="90210, 90211, 90212"
                  className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm text-foreground resize-none"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">Monthly Marketing Budget ($)</label>
                <input
                  type="number"
                  value={newBudget}
                  onChange={(e) => setNewBudget(e.target.value)}
                  min="0"
                  className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm text-foreground"
                />
              </div>
            </div>
            <div className="flex gap-3 mt-6 justify-end">
              <button
                onClick={() => { setShowTerritoryModal(false); setEditTerritory(null) }}
                className="px-4 py-2 rounded-lg border border-border text-sm text-foreground hover:bg-muted"
              >
                Cancel
              </button>
              <button
                onClick={() => void handleSaveTerritory()}
                disabled={!newName.trim()}
                className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 disabled:opacity-50"
              >
                {editTerritory ? "Save Changes" : "Create Territory"}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  )
}
