"use client"

import { ScatterChart, Scatter, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, ReferenceLine } from "recharts"

interface Props {
  data: any[]
}

export function LTVScatterChart({ data }: Props) {
  if (!data || data.length === 0) {
    return (
      <div className="h-80 flex items-center justify-center text-muted-foreground">
        No LTV data available yet
      </div>
    )
  }

  const chartData = data.map((item: any) => ({
    cost: (item.total_recruiting_cost || 0) / 100,
    ltv: (item.lifetime_brokerage_net || 0) / 100,
    roi: item.roi_pct || 0,
    recruit: `${item.agents?.first_name} ${item.agents?.last_name}`.substring(0, 10),
  }))

  const maxCost = Math.max(...chartData.map(d => d.cost))
  const maxLTV = Math.max(...chartData.map(d => d.ltv))

  return (
    <ResponsiveContainer width="100%" height={300}>
      <ScatterChart margin={{ top: 20, right: 20, bottom: 20, left: 20 }}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis 
          dataKey="cost" 
          name="Acquisition Cost ($)" 
          label={{ value: "Acquisition Cost ($K)", position: "insideBottomRight", offset: -10 }}
        />
        <YAxis 
          dataKey="ltv" 
          name="Lifetime Value ($)" 
          label={{ value: "Lifetime Value ($K)", angle: -90, position: "insideLeft" }}
        />
        <Tooltip 
          cursor={{ strokeDasharray: "3 3" }} 
          content={({ active, payload }) => {
            if (active && payload?.[0]) {
              const point = payload[0].payload
              return (
                <div className="bg-background border rounded p-2 text-xs">
                  <p className="font-semibold">{point.recruit}</p>
                  <p>Cost: ${point.cost.toFixed(0)}K</p>
                  <p>LTV: ${point.ltv.toFixed(0)}K</p>
                  <p>ROI: {point.roi.toFixed(0)}%</p>
                </div>
              )
            }
            return null
          }}
        />
        <ReferenceLine x={(maxCost * 0.5)} stroke="#e5e7eb" strokeDasharray="3 3" />
        <ReferenceLine y={(maxLTV * 0.5)} stroke="#e5e7eb" strokeDasharray="3 3" />
        <Scatter name="Recruits" data={chartData} fill="#06b6d4" />
      </ScatterChart>
    </ResponsiveContainer>
  )
}
