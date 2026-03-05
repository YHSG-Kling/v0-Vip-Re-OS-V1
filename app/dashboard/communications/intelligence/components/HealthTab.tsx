"use client"

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
import { Progress } from "@/components/ui/progress"

interface DayPoint {
  date: string          // "MM/DD"
  text_score: number    // 0-100
  voice_score: number   // 0-100
}

interface InsightRow {
  id: string
  contact_name: string
  agent_name: string
  overall_sentiment: string
  trajectory: string
  health_score: number     // 0-1
  response_time_avg: number | null
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

function healthColor(pct: number) {
  if (pct >= 70) return "bg-green-500"
  if (pct >= 50) return "bg-yellow-500"
  return "bg-red-500"
}

export default function HealthTab({ chartData, insights }: HealthTabProps) {
  return (
    <div className="space-y-6">
      {/* LineChart */}
      <div className="rounded-lg border border-border bg-card p-4">
        <h3 className="text-sm font-semibold text-foreground mb-4">Health Score — Last 30 Days</h3>
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={chartData} margin={{ top: 4, right: 16, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
            <XAxis dataKey="date" tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
            <YAxis domain={[0, 100]} tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
            <Tooltip
              formatter={(value: number, name: string) => [`${value}%`, name]}
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
            <Line
              type="monotone"
              dataKey="voice_score"
              name="Voice"
              stroke="hsl(var(--chart-2))"
              dot={false}
              strokeWidth={2}
              strokeDasharray="4 2"
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* Table */}
      <div className="rounded-lg border border-border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted text-muted-foreground">
              <tr>
                {["Contact","Agent","Sentiment","Trajectory","Health","Resp.Time","Unanswered","Escalate","Updated"].map(h => (
                  <th key={h} className="px-3 py-2 text-left text-xs font-medium whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border bg-card">
              {insights.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-3 py-6 text-center text-muted-foreground text-xs">No data</td>
                </tr>
              )}
              {insights.map(row => {
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
                    <td className="px-3 py-2 text-lg">{trajectoryIcon(row.trajectory)}</td>
                    <td className="px-3 py-2 min-w-[100px]">
                      <div className="flex items-center gap-2">
                        <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
                          <div className={`h-full rounded-full ${healthColor(pct)}`} style={{ width: `${pct}%` }} />
                        </div>
                        <span className="text-xs text-muted-foreground w-8 shrink-0">{pct}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2 text-muted-foreground text-xs">
                      {row.response_time_avg != null ? `${Math.round(row.response_time_avg)}m` : "—"}
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
