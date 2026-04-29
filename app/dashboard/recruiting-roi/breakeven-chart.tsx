"use client"

import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ReferenceLine, ResponsiveContainer } from "recharts"

interface Props {
  data: any
}

export function BreakEvenChart({ data }: Props) {
  if (!data || !data.breakeven_by_cohort) {
    return (
      <div className="h-80 flex items-center justify-center text-muted-foreground">
        No breakeven data available yet
      </div>
    )
  }

  const chartData = data.breakeven_by_cohort.map((item: any) => ({
    cohort: item.hire_month,
    months: item.avg_breakeven_months,
  }))

  return (
    <ResponsiveContainer width="100%" height={300}>
      <BarChart data={chartData}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis dataKey="cohort" fontSize={12} />
        <YAxis label={{ value: "Months", angle: -90, position: "insideLeft" }} />
        <Tooltip formatter={((value: number) => `${value.toFixed(1)} months`) as any} />
        <Legend />
        <ReferenceLine 
          y={data.avg_breakeven_months} 
          stroke="#666" 
          strokeDasharray="5 5" 
          label={`Avg: ${data.avg_breakeven_months.toFixed(1)}mo`}
        />
        <Bar dataKey="months" fill="#8b5cf6" name="Months to Breakeven" />
      </BarChart>
    </ResponsiveContainer>
  )
}
