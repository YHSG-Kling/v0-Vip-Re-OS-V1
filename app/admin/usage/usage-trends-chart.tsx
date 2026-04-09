"use client"

import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from "recharts"

interface TrendDataPoint {
  meter_type: string
  total_units: number
  total_cost_cents: number
  period_start: string
}

interface UsageTrendsChartProps {
  data: TrendDataPoint[]
}

export function UsageTrendsChart({ data }: UsageTrendsChartProps) {
  if (!data || data.length === 0) {
    return (
      <div className="h-[350px] flex items-center justify-center text-muted-foreground">
        No trend data available. Usage data will appear after the first billing period.
      </div>
    )
  }

  // Transform data: group by month, pivot meter_type into columns
  const monthlyData = new Map<string, { month: string; ai_call: number; voice_call: number; storage: number; video: number }>()
  
  data.forEach((d) => {
    const month = d.period_start?.slice(0, 7) || "unknown"
    if (!monthlyData.has(month)) {
      monthlyData.set(month, { month, ai_call: 0, voice_call: 0, storage: 0, video: 0 })
    }
    const entry = monthlyData.get(month)!
    if (d.meter_type === "ai_call") entry.ai_call = d.total_units || 0
    if (d.meter_type === "voice_call") entry.voice_call = d.total_units || 0
    if (d.meter_type === "storage") entry.storage = Math.round((d.total_units || 0) / (1024 * 1024)) // Convert to MB
    if (d.meter_type === "video") entry.video = d.total_units || 0
  })

  const chartData = Array.from(monthlyData.values()).sort((a, b) => a.month.localeCompare(b.month))

  // Format month labels
  const formatMonth = (month: string) => {
    try {
      const [year, m] = month.split("-")
      const date = new Date(parseInt(year), parseInt(m) - 1)
      return date.toLocaleDateString("en-US", { month: "short", year: "2-digit" })
    } catch {
      return month
    }
  }

  return (
    <div className="h-[350px]">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={chartData} margin={{ top: 20, right: 30, left: 20, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
          <XAxis 
            dataKey="month"
            tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }}
            axisLine={{ stroke: "hsl(var(--border))" }}
            tickFormatter={formatMonth}
          />
          <YAxis 
            tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }}
            axisLine={{ stroke: "hsl(var(--border))" }}
            tickFormatter={(value: number | undefined) => {
              const v = value ?? 0
              return v.toLocaleString()
            }}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: "hsl(var(--background))",
              border: "1px solid hsl(var(--border))",
              borderRadius: "8px",
            }}
            labelStyle={{ color: "hsl(var(--foreground))" }}
            labelFormatter={(label: React.ReactNode) => formatMonth(String(label))}
            formatter={(value: number | undefined, name: string) => {
              const v = value ?? 0
              const labels: Record<string, string> = {
                ai_call: "AI Calls",
                voice_call: "Voice Minutes",
                storage: "Storage (MB)",
                video: "Video Minutes",
              }
              return [v.toLocaleString(), labels[name] || name]
            }}
          />
          <Legend 
            formatter={(value) => {
              const labels: Record<string, string> = {
                ai_call: "AI Calls",
                voice_call: "Voice Minutes",
                storage: "Storage (MB)",
                video: "Video Minutes",
              }
              return labels[value] || value
            }}
          />
          <Line 
            type="monotone" 
            dataKey="ai_call" 
            stroke="#3b82f6" 
            strokeWidth={2}
            dot={{ fill: "#3b82f6", strokeWidth: 2 }}
            activeDot={{ r: 6 }}
          />
          <Line 
            type="monotone" 
            dataKey="voice_call" 
            stroke="#10b981" 
            strokeWidth={2}
            dot={{ fill: "#10b981", strokeWidth: 2 }}
            activeDot={{ r: 6 }}
          />
          <Line 
            type="monotone" 
            dataKey="storage" 
            stroke="#f59e0b" 
            strokeWidth={2}
            dot={{ fill: "#f59e0b", strokeWidth: 2 }}
            activeDot={{ r: 6 }}
          />
          <Line 
            type="monotone" 
            dataKey="video" 
            stroke="#8b5cf6" 
            strokeWidth={2}
            dot={{ fill: "#8b5cf6", strokeWidth: 2 }}
            activeDot={{ r: 6 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
