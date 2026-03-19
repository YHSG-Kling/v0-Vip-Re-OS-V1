"use client"

import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts"

interface Props {
  data: any[]
}

export function YearlyRevenueChart({ data }: Props) {
  if (!data || data.length === 0) {
    return (
      <div className="h-80 flex items-center justify-center text-muted-foreground">
        No revenue data available yet
      </div>
    )
  }

  const chartData = data.map((item: any) => ({
    recruit: `${item.agents?.first_name} ${item.agents?.last_name}`.substring(0, 12),
    year1: (item.year1_revenue || 0) / 100,
    year2: (item.year2_revenue || 0) / 100,
    year3: (item.year3_revenue || 0) / 100,
  }))

  return (
    <ResponsiveContainer width="100%" height={300}>
      <BarChart data={chartData}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis dataKey="recruit" fontSize={12} />
        <YAxis label={{ value: "Revenue ($K)", angle: -90, position: "insideLeft" }} />
        <Tooltip formatter={(value) => `$${(value * 1000).toLocaleString()}`} />
        <Legend />
        <Bar dataKey="year1" fill="#3b82f6" name="Year 1" />
        <Bar dataKey="year2" fill="#10b981" name="Year 2" />
        <Bar dataKey="year3" fill="#f59e0b" name="Year 3" />
      </BarChart>
    </ResponsiveContainer>
  )
}
