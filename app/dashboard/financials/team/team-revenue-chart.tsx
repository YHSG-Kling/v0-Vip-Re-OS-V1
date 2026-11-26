"use client"

import {
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
  Line,
  ComposedChart,
} from "recharts"
import { useMemo } from "react"

interface EarningsRecord {
  id: string
  agent_id: string
  gross_commission: number
  agent_net: number
  recorded_at: string
  agents?: {
    id: string
    team_id: string
    users?: {
      first_name: string
      last_name: string
    }
  }
}

interface Agent {
  id: string
  user_id: string
  users?: {
    first_name: string
    last_name: string
  }
}

interface TeamRevenueChartProps {
  earningsHistory: EarningsRecord[]
  teamAgents: Agent[]
}

// Generate consistent colors for agents
const AGENT_COLORS = [
  "#3b82f6", // blue
  "#10b981", // emerald
  "#f59e0b", // amber
  "#ef4444", // red
  "#8b5cf6", // violet
  "#ec4899", // pink
  "#14b8a6", // teal
  "#f97316", // orange
]

export function TeamRevenueChart({ earningsHistory, teamAgents }: TeamRevenueChartProps) {
  // Process earnings history into monthly buckets by agent
  const chartData = useMemo(() => {
    const monthlyData: Record<string, Record<string, any>> = {}

    // Group by month
    earningsHistory.forEach((record) => {
      const date = new Date(record.recorded_at)
      const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`

      if (!monthlyData[monthKey]) {
        monthlyData[monthKey] = { month: monthKey, total: 0 }
      }

      const agentId = record.agent_id
      const agentName = record.agents?.users
        ? `${record.agents.users.first_name || ""} ${record.agents.users.last_name || ""}`.trim().substring(0, 12)
        : agentId.substring(0, 8)

      if (!monthlyData[monthKey][agentName]) {
        monthlyData[monthKey][agentName] = 0
      }

      monthlyData[monthKey][agentName] += record.gross_commission || 0
      monthlyData[monthKey].total += record.gross_commission || 0
    })

    // Convert to array and sort by month
    const sortedData = Object.values(monthlyData)
      .sort((a, b) => String(a.month).localeCompare(String(b.month)))
      .slice(-6) // Last 6 months

    // Format month labels
    return sortedData.map((item) => {
      const [year, month] = String(item.month).split("-")
      const date = new Date(parseInt(year), parseInt(month) - 1)
      return {
        ...item,
        monthLabel: date.toLocaleDateString("en-US", { month: "short", year: "2-digit" }),
      }
    })
  }, [earningsHistory])

  // Get unique agent names for bars
  const agentNames = useMemo(() => {
    const names = new Set<string>()
    chartData.forEach((month) => {
      Object.keys(month).forEach((key) => {
        if (!["month", "monthLabel", "total"].includes(key)) {
          names.add(key)
        }
      })
    })
    return Array.from(names).slice(0, 8) // Max 8 agents for readability
  }, [chartData])

  if (chartData.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        No earnings data available for the last 6 months
      </div>
    )
  }

  return (
    <ResponsiveContainer width="100%" height="100%">
      <ComposedChart data={chartData} margin={{ top: 20, right: 30, left: 20, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
        <XAxis
          dataKey="monthLabel"
          tick={{ fontSize: 12 }}
          tickLine={false}
          axisLine={false}
        />
        <YAxis
          tick={{ fontSize: 12 }}
          tickLine={false}
          axisLine={false}
          tickFormatter={(value) => `$${(value / 1000).toFixed(0)}k`}
        />
        <Tooltip
          formatter={((value: number, name: string) => [
            `$${value.toLocaleString()}`,
            name === "total" ? "Total GCI" : name,
          ]) as any}
          contentStyle={{
            backgroundColor: "hsl(var(--background))",
            border: "1px solid hsl(var(--border))",
            borderRadius: "6px",
          }}
        />
        <Legend />

        {/* Stacked bars for each agent */}
        {agentNames.map((agentName, idx) => (
          <Bar
            key={agentName}
            dataKey={agentName}
            stackId="agents"
            fill={AGENT_COLORS[idx % AGENT_COLORS.length]}
            radius={idx === agentNames.length - 1 ? [4, 4, 0, 0] : [0, 0, 0, 0]}
          />
        ))}

        {/* Line for total GCI */}
        <Line
          type="monotone"
          dataKey="total"
          stroke="#000"
          strokeWidth={2}
          dot={{ r: 4 }}
          name="Total GCI"
        />
      </ComposedChart>
    </ResponsiveContainer>
  )
}
