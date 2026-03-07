"use client"

import { PieChart, Pie, Cell, Legend, Tooltip, RadialBarChart, RadialBar, ResponsiveContainer } from "recharts"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

interface SummaryCard {
  label: string
  value: string | number
}

interface CommandTypeData {
  name: string
  value: number
}

interface VoiceAnalyticsProps {
  summaryCards: SummaryCard[]
  commandTypeData: CommandTypeData[]
  avgConfidence: number // 0–1
}

const PIE_COLORS = ["#1d4ed8", "#0891b2", "#059669", "#d97706", "#dc2626", "#7c3aed"]

function confidenceColor(score: number): string {
  if (score >= 0.8) return "#16a34a"
  if (score >= 0.6) return "#d97706"
  return "#dc2626"
}

export function VoiceAnalytics({ summaryCards, commandTypeData, avgConfidence }: VoiceAnalyticsProps) {
  const pct = Math.round(avgConfidence * 100)
  const gaugeColor = confidenceColor(avgConfidence)

  const gaugeData = [
    { name: "accuracy", value: pct, fill: gaugeColor },
  ]

  return (
    <div className="space-y-4">
      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-3">
        {summaryCards.map((c) => (
          <Card key={c.label}>
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground">{c.label}</p>
              <p className="text-2xl font-bold text-foreground mt-1">{c.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Command type pie */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold">Command Types (7 days)</CardTitle>
        </CardHeader>
        <CardContent>
          {commandTypeData.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-6">No data yet</p>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie
                  data={commandTypeData}
                  cx="50%"
                  cy="50%"
                  innerRadius={50}
                  outerRadius={80}
                  paddingAngle={3}
                  dataKey="value"
                >
                  {commandTypeData.map((_, i) => (
                    <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{ fontSize: 11, borderRadius: 6 }}
                  formatter={(val: number, name: string) => [val, name]}
                />
                <Legend
                  iconType="circle"
                  iconSize={8}
                  wrapperStyle={{ fontSize: 11 }}
                />
              </PieChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      {/* Confidence gauge */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold">Intent Confidence (7 days)</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="relative">
            <ResponsiveContainer width="100%" height={140}>
              <RadialBarChart
                cx="50%"
                cy="80%"
                innerRadius="60%"
                outerRadius="100%"
                startAngle={180}
                endAngle={0}
                data={gaugeData}
              >
                <RadialBar
                  background={{ fill: "hsl(var(--muted))" }}
                  dataKey="value"
                  cornerRadius={6}
                  max={100}
                />
              </RadialBarChart>
            </ResponsiveContainer>
            <div className="absolute inset-0 flex items-end justify-center pb-2">
              <p className="text-2xl font-bold" style={{ color: gaugeColor }}>
                {pct}%
              </p>
            </div>
          </div>
          <p className="text-center text-xs text-muted-foreground mt-1">accuracy</p>
        </CardContent>
      </Card>
    </div>
  )
}
