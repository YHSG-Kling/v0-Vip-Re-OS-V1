"use client"

import { useState } from "react"
import {
  PieChart,
  Pie,
  Cell,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts"

interface VoiceInsight {
  id: string
  conversation_id: string
  contact_name: string
  agent_name: string
  voice_quality_score: number | null     // 0-1
  interruption_count: number | null
  silence_duration_seconds: number | null
  call_completion_status: string | null
  overall_sentiment: string | null
  recording_url: string | null
  transcript: string | null
  updated_at: string
}

interface VoiceTabProps {
  voiceInsights: VoiceInsight[]
}

interface GaugeCardProps {
  label: string
  value: string | number
  sub?: string
  color?: string
}

function GaugeCard({ label, value, sub, color = "text-foreground" }: GaugeCardProps) {
  return (
    <div className="rounded-lg border border-border bg-card p-4 flex flex-col gap-1">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`text-3xl font-bold ${color}`}>{value}</p>
      {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
    </div>
  )
}

function sentimentBadge(s: string | null) {
  const map: Record<string, string> = {
    positive: "bg-green-100 text-green-700",
    neutral:  "bg-gray-100 text-gray-600",
    negative: "bg-red-100 text-red-700",
  }
  return map[s ?? "neutral"] ?? "bg-gray-100 text-gray-600"
}

function qualityColor(pct: number) {
  if (pct >= 70) return "bg-green-500"
  if (pct >= 50) return "bg-yellow-500"
  return "bg-red-500"
}

const PIE_COLORS = ["#2563eb", "#16a34a", "#f59e0b", "#dc2626", "#7c3aed", "#0891b2"]

export default function VoiceTab({ voiceInsights }: VoiceTabProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null)

  if (voiceInsights.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-12 text-center border border-border rounded-lg">
        No voice call insights yet. Insights are generated automatically after calls are analyzed.
      </p>
    )
  }

  // Compute aggregate gauge values
  const withQuality = voiceInsights.filter(r => r.voice_quality_score != null)
  const avgQuality = withQuality.length > 0
    ? Math.round((withQuality.reduce((s, r) => s + (r.voice_quality_score! * 100), 0) / withQuality.length))
    : 0

  const withInterruptions = voiceInsights.filter(r => r.interruption_count != null)
  const avgInterruptions = withInterruptions.length > 0
    ? (withInterruptions.reduce((s, r) => s + r.interruption_count!, 0) / withInterruptions.length).toFixed(1)
    : "—"

  const withSilence = voiceInsights.filter(r => r.silence_duration_seconds != null)
  const avgSilence = withSilence.length > 0
    ? (withSilence.reduce((s, r) => s + r.silence_duration_seconds!, 0) / withSilence.length).toFixed(0)
    : "—"

  // Completion status distribution
  const completionMap: Record<string, number> = {}
  for (const r of voiceInsights) {
    const key = r.call_completion_status ?? "unknown"
    completionMap[key] = (completionMap[key] ?? 0) + 1
  }
  const pieData = Object.entries(completionMap).map(([name, value]) => ({ name, value }))

  return (
    <div className="space-y-6">
      {/* Gauge cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <GaugeCard
          label="Avg Voice Quality"
          value={`${avgQuality}%`}
          sub="Based on voice_quality_score"
          color={avgQuality >= 70 ? "text-green-700" : avgQuality >= 50 ? "text-yellow-700" : "text-red-700"}
        />
        <GaugeCard
          label="Avg Interruptions"
          value={avgInterruptions}
          sub="Per call"
        />
        <GaugeCard
          label="Avg Silence Duration"
          value={avgSilence === "—" ? "—" : `${avgSilence}s`}
          sub="Per call"
        />
      </div>

      {/* Completion PieChart */}
      <div className="rounded-lg border border-border bg-card p-4">
        <h3 className="text-sm font-semibold text-foreground mb-4">Call Completion Status</h3>
        {pieData.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-4">No data</p>
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <PieChart>
              <Pie
                data={pieData}
                dataKey="value"
                nameKey="name"
                cx="50%"
                cy="50%"
                outerRadius={80}
                label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
                labelLine={false}
              >
                {pieData.map((_, i) => (
                  <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                ))}
              </Pie>
              <Tooltip
                formatter={(v: number) => [v, "Calls"]}
                contentStyle={{ fontSize: 12, borderRadius: 6, border: "1px solid hsl(var(--border))" }}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
            </PieChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Voice call table */}
      <div className="rounded-lg border border-border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted text-muted-foreground">
              <tr>
                {["Contact","Agent","Quality","Interruptions","Silence (s)","Completion","Sentiment","Recording"].map(h => (
                  <th key={h} className="px-3 py-2 text-left text-xs font-medium whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border bg-card">
              {voiceInsights.map(row => {
                const qPct = row.voice_quality_score != null ? Math.round(row.voice_quality_score * 100) : null
                const isExpanded = expandedId === row.id
                return (
                  <>
                    <tr
                      key={row.id}
                      className={`hover:bg-muted/40 transition-colors cursor-pointer ${isExpanded ? "bg-muted/20" : ""}`}
                      onClick={() => setExpandedId(isExpanded ? null : row.id)}
                    >
                      <td className="px-3 py-2 font-medium text-foreground whitespace-nowrap">{row.contact_name}</td>
                      <td className="px-3 py-2 text-muted-foreground whitespace-nowrap">{row.agent_name}</td>
                      <td className="px-3 py-2 min-w-[100px]">
                        {qPct != null ? (
                          <div className="flex items-center gap-2">
                            <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
                              <div className={`h-full rounded-full ${qualityColor(qPct)}`} style={{ width: `${qPct}%` }} />
                            </div>
                            <span className="text-xs text-muted-foreground w-8 shrink-0">{qPct}</span>
                          </div>
                        ) : <span className="text-muted-foreground text-xs">—</span>}
                      </td>
                      <td className="px-3 py-2 text-center">
                        {row.interruption_count ?? <span className="text-muted-foreground">—</span>}
                      </td>
                      <td className="px-3 py-2 text-center">
                        {row.silence_duration_seconds != null
                          ? `${Math.round(row.silence_duration_seconds)}s`
                          : <span className="text-muted-foreground">—</span>}
                      </td>
                      <td className="px-3 py-2">
                        <span className="inline-block px-2 py-0.5 rounded-full text-xs capitalize bg-muted text-muted-foreground">
                          {row.call_completion_status ?? "—"}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium capitalize ${sentimentBadge(row.overall_sentiment)}`}>
                          {row.overall_sentiment ?? "—"}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        {row.recording_url ? (
                          <a
                            href={row.recording_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={e => e.stopPropagation()}
                            className="text-xs px-2 py-1 rounded bg-primary text-primary-foreground hover:opacity-90"
                          >
                            Play
                          </a>
                        ) : (
                          <span className="text-muted-foreground text-xs">—</span>
                        )}
                      </td>
                    </tr>
                    {isExpanded && row.transcript && (
                      <tr key={`${row.id}-transcript`}>
                        <td colSpan={8} className="px-4 py-3 bg-muted/30">
                          <p className="text-xs font-semibold text-muted-foreground mb-1">Transcript</p>
                          <p className="text-xs text-foreground whitespace-pre-wrap leading-relaxed max-h-48 overflow-y-auto">
                            {row.transcript}
                          </p>
                        </td>
                      </tr>
                    )}
                    {isExpanded && !row.transcript && (
                      <tr key={`${row.id}-no-transcript`}>
                        <td colSpan={8} className="px-4 py-3 bg-muted/30">
                          <p className="text-xs text-muted-foreground italic">No transcript available.</p>
                        </td>
                      </tr>
                    )}
                  </>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
