"use client"

import { useState } from "react"
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  RadialBarChart,
  RadialBar,
  PolarAngleAxis,
} from "recharts"

interface AgentInsight {
  agent_id: string
  agent_name: string
  avg_sentiment_score: number       // 0-100
  avg_health_score: number          // 0-100
  objections_raised: string[]
  buying_signals: string[]
  response_time_avg_seconds: number | null
  conversation_count: number
}

interface CoachingTabProps {
  agentInsights: AgentInsight[]
  teamAvgResponseTime: number
  topicFrequency: { topic: string; count: number }[]
}

function initials(name: string) {
  return name.split(" ").map(p => p[0]?.toUpperCase() ?? "").join("").slice(0, 2)
}

function topN(arr: string[], n = 5): { label: string; count: number }[] {
  const freq: Record<string, number> = {}
  for (const item of arr) {
    if (item) freq[item] = (freq[item] ?? 0) + 1
  }
  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([label, count]) => ({ label, count }))
}

function CoachingPoint({ type, title, detail }: { type: string; title: string; detail: string }) {
  const styles: Record<string, string> = {
    strength:    "border-green-400 bg-green-50",
    improvement: "border-yellow-400 bg-yellow-50",
    action:      "border-blue-400 bg-blue-50",
  }
  const labels: Record<string, string> = {
    strength:    "Strength",
    improvement: "Improvement",
    action:      "Action Item",
  }
  const textColors: Record<string, string> = {
    strength:    "text-green-700",
    improvement: "text-yellow-700",
    action:      "text-blue-700",
  }
  return (
    <div className={`border-l-4 rounded-r-lg p-3 ${styles[type] ?? "border-gray-300 bg-gray-50"}`}>
      <p className={`text-xs font-bold uppercase tracking-wide mb-1 ${textColors[type] ?? "text-gray-600"}`}>
        {labels[type] ?? type}
      </p>
      <p className="text-sm font-semibold text-foreground">{title}</p>
      <p className="text-xs text-muted-foreground mt-0.5">{detail}</p>
    </div>
  )
}

function AgentCard({
  insight,
  teamAvgResponseTime,
}: {
  insight: AgentInsight
  teamAvgResponseTime: number
}) {
  const [expanded, setExpanded] = useState(false)
  const [coachingPoints, setCoachingPoints] = useState<
    { type: string; title: string; detail: string }[] | null
  >(null)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const topObjections = topN(insight.objections_raised)
  const topSignals    = topN(insight.buying_signals)
  const sentimentData = [{ value: insight.avg_sentiment_score, fill: "hsl(var(--primary))" }]

  async function handleGenerate() {
    setGenerating(true)
    setError(null)
    setCoachingPoints(null)
    try {
      const res = await fetch("/api/intelligence/coaching", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: insight.agent_id,
          agentName: insight.agent_name,
          insightData: {
            avgHealthScore:       Math.round(insight.avg_health_score),
            avgSentimentScore:    Math.round(insight.avg_sentiment_score),
            topObjections:        topObjections.map(o => o.label),
            topBuyingSignals:     topSignals.map(s => s.label),
            avgResponseTime:      insight.response_time_avg_seconds ?? 0,
            teamAvgResponseTime,
            unansweredCount:      0,
          },
        }),
      })
      if (!res.ok) throw new Error("Failed to generate coaching")
      // Route returns plain JSON array — parse directly
      const points = await res.json()
      if (!Array.isArray(points)) throw new Error("Invalid coaching response")
      setCoachingPoints(points)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Unknown error")
    } finally {
      setGenerating(false)
    }
  }

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      {/* Agent header */}
      <div
        className="flex items-center gap-3 p-4 cursor-pointer hover:bg-muted/40 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="h-10 w-10 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-sm font-bold shrink-0">
          {initials(insight.agent_name)}
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-sm text-foreground truncate">{insight.agent_name}</p>
          <p className="text-xs text-muted-foreground">{insight.conversation_count} conversations</p>
        </div>
        <div className="flex items-center gap-4 shrink-0">
          {/* Sentiment RadialBar gauge */}
          <div className="w-14 h-14">
            <RadialBarChart
              width={56}
              height={56}
              innerRadius={18}
              outerRadius={26}
              data={sentimentData}
              startAngle={90}
              endAngle={-270}
            >
              <PolarAngleAxis type="number" domain={[0, 100]} angleAxisId={0} tick={false} />
              <RadialBar
                background={{ fill: "hsl(var(--muted))" }}
                dataKey="value"
                angleAxisId={0}
                cornerRadius={4}
              />
              <text x={28} y={32} textAnchor="middle" className="text-[10px] font-bold fill-foreground">
                {Math.round(insight.avg_sentiment_score)}
              </text>
            </RadialBarChart>
          </div>
          <span className="text-muted-foreground text-sm">{expanded ? "▲" : "▼"}</span>
        </div>
      </div>

      {/* Expanded content */}
      {expanded && (
        <div className="border-t border-border p-4 space-y-4">
          {/* Stats row */}
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <div className="rounded bg-muted p-3">
              <p className="text-xs text-muted-foreground">Avg Health</p>
              <p className="text-xl font-bold text-foreground">{Math.round(insight.avg_health_score)}%</p>
            </div>
            <div className="rounded bg-muted p-3">
              <p className="text-xs text-muted-foreground">Avg Response</p>
              <p className="text-xl font-bold text-foreground">
                {insight.response_time_avg_seconds != null
                  ? `${Math.round(insight.response_time_avg_seconds)}s`
                  : "—"}
              </p>
              {insight.response_time_avg_seconds != null && (
                <p className="text-[10px] text-muted-foreground">
                  Team avg: {Math.round(teamAvgResponseTime)}s
                </p>
              )}
            </div>
            <div className="rounded bg-muted p-3">
              <p className="text-xs text-muted-foreground">Sentiment Score</p>
              <p className="text-xl font-bold text-foreground">{Math.round(insight.avg_sentiment_score)}/100</p>
            </div>
          </div>

          {/* Top objections + signals */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <p className="text-xs font-semibold text-muted-foreground mb-2 uppercase tracking-wide">Top Objections</p>
              {topObjections.length === 0
                ? <p className="text-xs text-muted-foreground">None recorded</p>
                : topObjections.map(o => (
                  <div key={o.label} className="flex items-center justify-between text-xs py-0.5">
                    <span className="text-foreground truncate">{o.label}</span>
                    <span className="ml-2 font-medium text-muted-foreground shrink-0">×{o.count}</span>
                  </div>
                ))}
            </div>
            <div>
              <p className="text-xs font-semibold text-muted-foreground mb-2 uppercase tracking-wide">Top Buying Signals</p>
              {topSignals.length === 0
                ? <p className="text-xs text-muted-foreground">None recorded</p>
                : topSignals.map(s => (
                  <div key={s.label} className="flex items-center justify-between text-xs py-0.5">
                    <span className="text-foreground truncate">{s.label}</span>
                    <span className="ml-2 font-medium text-muted-foreground shrink-0">×{s.count}</span>
                  </div>
                ))}
            </div>
          </div>

          {/* AI Coaching Panel */}
          <div className="border-t border-border pt-4">
            <div className="flex items-center justify-between mb-3">
              <p className="text-xs font-semibold text-foreground">AI Coaching</p>
              <button
                onClick={handleGenerate}
                disabled={generating}
                className="text-xs px-3 py-1.5 bg-primary text-primary-foreground rounded hover:opacity-90 disabled:opacity-40"
              >
                {generating ? "Generating…" : coachingPoints ? "Regenerate" : "Generate Coaching"}
              </button>
            </div>
            {error && <p className="text-xs text-red-600">{error}</p>}
            {coachingPoints && (
              <div className="space-y-2">
                {coachingPoints.map((pt, i) => (
                  <CoachingPoint key={i} type={pt.type} title={pt.title} detail={pt.detail} />
                ))}
              </div>
            )}
            {!coachingPoints && !generating && !error && (
              <p className="text-xs text-muted-foreground">
                Click "Generate Coaching" to get AI-powered coaching insights for this agent.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export default function CoachingTab({ agentInsights, teamAvgResponseTime, topicFrequency }: CoachingTabProps) {
  if (agentInsights.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-12 text-center border border-border rounded-lg">
        No agent conversation data yet. Insights are generated automatically as messages are analyzed.
      </p>
    )
  }

  return (
    <div className="space-y-6">
      {/* Conversation Themes BarChart */}
      {topicFrequency.length > 0 && (
        <div className="rounded-lg border border-border bg-card p-4">
          <h3 className="text-sm font-semibold text-foreground mb-4">Conversation Themes — Last 30 Days</h3>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart
              data={topicFrequency.slice(0, 10)}
              layout="vertical"
              margin={{ top: 0, right: 16, bottom: 0, left: 80 }}
            >
              <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="hsl(var(--border))" />
              <XAxis type="number" tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
              <YAxis dataKey="topic" type="category" tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" width={76} />
              <Tooltip
                formatter={((v: number) => [v, "Mentions"]) as any}
                contentStyle={{ fontSize: 12, borderRadius: 6, border: "1px solid hsl(var(--border))" }}
              />
              <Bar dataKey="count" fill="hsl(var(--primary))" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Agent cards */}
      <div className="space-y-3">
        {agentInsights.map(insight => (
          <AgentCard key={insight.agent_id} insight={insight} teamAvgResponseTime={teamAvgResponseTime} />
        ))}
      </div>
    </div>
  )
}
