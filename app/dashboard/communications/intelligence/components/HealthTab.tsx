"use client"

// TOMBSTONE (orphan doctrine §1.3, 2026-09-01): the sibling InsightsTab.tsx
// (same directory) was deleted — never imported by IntelligenceClient, and
// written against columns conversation_insights does not have (top_topics,
// key_questions, next_best_action do not exist; the live table carries
// key_topics / unresolved_questions). Its live functionality already lives
// elsewhere: the per-conversation sentiment/health/escalation list is THIS
// tab's insights table, and topic display is CoachingTab's topicFrequency
// chart (fed from key_topics in page.tsx). Nothing renderable was lost.

import { useMemo, useState } from "react"
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts"
import { Badge } from "@/components/ui/badge"
import Link from "next/link"

interface DayPoint {
  date: string        // "MM/DD"
  // null = nothing was measured on that series that day; the line gaps rather
  // than drawing a zero. (The voice series was a permanent fabricated 0 while
  // it was fed from conversation_insights.is_voice_conversation — a filter the
  // text analyser's constant-false stamp guaranteed could never match. It now
  // reads the dialled-call ledger: avg call_analyses.coaching_score per day.)
  text_score: number | null  // 0-100 — conversation_insights.health_score × 100
  voice_score: number | null // 0-100 — call_analyses.coaching_score
}

interface InsightRow {
  id: string
  contact_name: string
  agent_name: string
  overall_sentiment: string
  trajectory: string
  health_score: number          // 0-1 from DB (RSC passes raw value)
  response_time_avg: number | null  // seconds (DB column: response_time_avg_seconds)
  unanswered_questions_count: number
  escalation_recommended: boolean
  updated_at: string
}

interface HealthTabProps {
  chartData: DayPoint[]
  insights: InsightRow[]
}

function sentimentBadge(sentiment: string) {
  const map: Record<string, string> = {
    positive: "bg-green-100 text-green-700",
    neutral:  "bg-gray-100 text-gray-600",
    negative: "bg-red-100 text-red-700",
  }
  return map[sentiment] ?? "bg-gray-100 text-gray-600"
}

function trajectoryIcon(t: string) {
  if (t === "improving") return "↑"
  if (t === "declining")  return "↓"
  if (t === "mixed")      return "~"
  return "→"
}

function healthBarColor(pct: number) {
  if (pct >= 70) return "bg-green-500"
  if (pct >= 50) return "bg-yellow-500"
  return "bg-red-500"
}

const SENTIMENTS = ["all", "positive", "neutral", "negative"] as const
type SentimentFilter = typeof SENTIMENTS[number]

export default function HealthTab({ chartData, insights }: HealthTabProps) {
  // ── Filters ──────────────────────────────────────────────────────────────
  const [dateFrom, setDateFrom] = useState("")
  const [dateTo, setDateTo] = useState("")
  const [agentFilter, setAgentFilter] = useState("")
  const [sentimentFilter, setSentimentFilter] = useState<SentimentFilter>("all")
  const [escalationOnly, setEscalationOnly] = useState(false)

  // Build unique agent list from data
  const agentNames = useMemo(
    () => Array.from(new Set(insights.map(r => r.agent_name).filter(Boolean))).sort(),
    [insights]
  )

  const filtered = useMemo(() => {
    return insights.filter(row => {
      if (sentimentFilter !== "all" && row.overall_sentiment !== sentimentFilter) return false
      if (agentFilter && row.agent_name !== agentFilter) return false
      if (escalationOnly && !row.escalation_recommended) return false
      if (dateFrom && new Date(row.updated_at) < new Date(dateFrom)) return false
      if (dateTo && new Date(row.updated_at) > new Date(dateTo + "T23:59:59")) return false
      return true
    })
  }, [insights, sentimentFilter, agentFilter, escalationOnly, dateFrom, dateTo])

  return (
    <div className="space-y-6">
      {/* LineChart */}
      <div className="rounded-lg border border-border bg-card p-4">
        <h3 className="text-sm font-semibold text-foreground mb-4">Health Score — Last 30 Days</h3>
        {chartData.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">
            No conversation insights yet. Insights are generated automatically as messages are analyzed.
          </p>
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={chartData} margin={{ top: 4, right: 16, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
              <YAxis domain={[0, 100]} tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
              <Tooltip
                formatter={((value: number, name: string) => [`${value}%`, name]) as any}
                contentStyle={{ fontSize: 12, borderRadius: 6, border: "1px solid hsl(var(--border))" }}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Line
                type="monotone"
                dataKey="text_score"
                name="Email / SMS"
                stroke="hsl(var(--primary))"
                dot={false}
                strokeWidth={2}
              />
              {/* A different instrument than the text line, and labeled as such:
                  this is the call ledger's coaching score, not a health_score
                  sibling — conversation_insights carries no voice rows by ruling. */}
              <Line
                type="monotone"
                dataKey="voice_score"
                name="Voice (call coaching)"
                stroke="hsl(var(--chart-2))"
                dot={false}
                strokeWidth={2}
                strokeDasharray="4 2"
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-muted-foreground">From</label>
          <input
            type="date"
            value={dateFrom}
            onChange={e => setDateFrom(e.target.value)}
            className="text-xs border border-border rounded px-2 py-1.5 bg-background text-foreground h-8"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-muted-foreground">To</label>
          <input
            type="date"
            value={dateTo}
            onChange={e => setDateTo(e.target.value)}
            className="text-xs border border-border rounded px-2 py-1.5 bg-background text-foreground h-8"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-muted-foreground">Agent</label>
          <select
            value={agentFilter}
            onChange={e => setAgentFilter(e.target.value)}
            className="text-xs border border-border rounded px-2 py-1.5 bg-background text-foreground h-8 min-w-[130px]"
          >
            <option value="">All agents</option>
            {agentNames.map(a => <option key={a} value={a}>{a}</option>)}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-muted-foreground">Sentiment</label>
          <select
            value={sentimentFilter}
            onChange={e => setSentimentFilter(e.target.value as SentimentFilter)}
            className="text-xs border border-border rounded px-2 py-1.5 bg-background text-foreground h-8"
          >
            {SENTIMENTS.map(s => <option key={s} value={s}>{s === "all" ? "All sentiments" : s}</option>)}
          </select>
        </div>
        <label className="flex items-center gap-1.5 cursor-pointer text-xs text-foreground h-8 self-end pb-0.5">
          <input
            type="checkbox"
            checked={escalationOnly}
            onChange={e => setEscalationOnly(e.target.checked)}
            className="rounded"
          />
          Escalation only
        </label>
        {(dateFrom || dateTo || agentFilter || sentimentFilter !== "all" || escalationOnly) && (
          <button
            onClick={() => { setDateFrom(""); setDateTo(""); setAgentFilter(""); setSentimentFilter("all"); setEscalationOnly(false) }}
            className="text-xs text-muted-foreground hover:text-foreground underline self-end pb-1"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Table */}
      <div className="rounded-lg border border-border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted text-muted-foreground">
              <tr>
                {["Contact","Agent","Sentiment","Trajectory","Health","Resp. Time","Unanswered","Escalate","Updated",""].map(h => (
                  <th key={h} className="px-3 py-2 text-left text-xs font-medium whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border bg-card">
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={10} className="px-3 py-8 text-center text-muted-foreground text-sm">
                    No conversation insights yet. Insights are generated automatically as messages are analyzed.
                  </td>
                </tr>
              )}
              {filtered.map(row => {
                // health_score is 0-1 from DB, convert to 0-100 for display
                const pct = Math.round(row.health_score * 100)
                return (
                  <tr key={row.id} className="hover:bg-muted/40 transition-colors">
                    <td className="px-3 py-2 font-medium text-foreground whitespace-nowrap">{row.contact_name}</td>
                    <td className="px-3 py-2 text-muted-foreground whitespace-nowrap">{row.agent_name}</td>
                    <td className="px-3 py-2">
                      <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium capitalize ${sentimentBadge(row.overall_sentiment)}`}>
                        {row.overall_sentiment}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-base font-medium" title={row.trajectory}>
                      {trajectoryIcon(row.trajectory)}
                    </td>
                    <td className="px-3 py-2 min-w-[110px]">
                      <div className="flex items-center gap-2">
                        <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
                          <div
                            className={`h-full rounded-full ${healthBarColor(pct)}`}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <span className="text-xs text-muted-foreground w-8 shrink-0">{pct}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2 text-muted-foreground text-xs whitespace-nowrap">
                      {/* DB column is response_time_avg_seconds — display as seconds */}
                      {row.response_time_avg != null ? `${Math.round(row.response_time_avg)}s` : "—"}
                    </td>
                    <td className="px-3 py-2 text-center">
                      {row.unanswered_questions_count > 0
                        ? <span className="text-yellow-600 font-semibold">{row.unanswered_questions_count}</span>
                        : <span className="text-muted-foreground">0</span>}
                    </td>
                    <td className="px-3 py-2">
                      {row.escalation_recommended
                        ? <Badge className="bg-red-100 text-red-700 border-0 text-xs">Yes</Badge>
                        : <span className="text-muted-foreground text-xs">No</span>}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground text-xs whitespace-nowrap">
                      {new Date(row.updated_at).toLocaleDateString()}
                    </td>
                    <td className="px-3 py-2">
                      <Link
                        href={`/dashboard/communications?conversation=${row.id}`}
                        className="text-xs text-primary underline hover:opacity-80 whitespace-nowrap"
                      >
                        View
                      </Link>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
