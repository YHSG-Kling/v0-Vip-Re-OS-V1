"use client"

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts"

interface HomeValueChartProps {
  estimates: Array<{
    estimated_value_mid: number
    generated_at: string
  }>
  purchasePrice?: number
  purchaseDate?: string
}

export function HomeValueChart({
  estimates,
  purchasePrice,
  purchaseDate,
}: HomeValueChartProps) {
  // Format data for recharts
  const data = estimates.map((est) => ({
    date: new Date(est.generated_at).toLocaleDateString("en-US", {
      month: "short",
      year: "2-digit",
    }),
    value: est.estimated_value_mid,
    fullDate: est.generated_at,
  }))

  // Add purchase price as first data point if available
  if (purchasePrice && purchaseDate) {
    const purchaseData = {
      date: new Date(purchaseDate).toLocaleDateString("en-US", {
        month: "short",
        year: "2-digit",
      }),
      value: purchasePrice,
      fullDate: purchaseDate,
      isPurchase: true,
    }
    
    // Only add if it's before the first estimate
    if (data.length === 0 || new Date(purchaseDate) < new Date(data[0].fullDate)) {
      data.unshift(purchaseData)
    }
  }

  const formatCurrency = (value: number) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
      notation: "compact",
    }).format(value)

  const CustomTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
      return (
        <div className="bg-background border rounded-lg shadow-lg p-3">
          <p className="text-sm text-muted-foreground">{label}</p>
          <p className="text-lg font-semibold">
            {new Intl.NumberFormat("en-US", {
              style: "currency",
              currency: "USD",
              maximumFractionDigits: 0,
            }).format(payload[0].value)}
          </p>
        </div>
      )
    }
    return null
  }

  return (
    <div className="h-[300px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart
          data={data}
          margin={{ top: 5, right: 30, left: 20, bottom: 5 }}
        >
          <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
          <XAxis
            dataKey="date"
            className="text-xs"
            tick={{ fill: "hsl(var(--muted-foreground))" }}
          />
          <YAxis
            tickFormatter={formatCurrency}
            className="text-xs"
            tick={{ fill: "hsl(var(--muted-foreground))" }}
            width={80}
          />
          <Tooltip content={<CustomTooltip />} />
          {purchasePrice && (
            <ReferenceLine
              y={purchasePrice}
              stroke="hsl(var(--muted-foreground))"
              strokeDasharray="5 5"
              label={{
                value: "Purchase Price",
                position: "insideTopRight",
                fill: "hsl(var(--muted-foreground))",
                fontSize: 12,
              }}
            />
          )}
          <Line
            type="monotone"
            dataKey="value"
            stroke="hsl(var(--primary))"
            strokeWidth={2}
            dot={{ fill: "hsl(var(--primary))", strokeWidth: 2, r: 4 }}
            activeDot={{ r: 6 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
