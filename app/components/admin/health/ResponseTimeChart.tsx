"use client"

import { useState, useEffect } from "react"
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  Legend,
} from "recharts"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { getResponseTimeLogs } from "@/app/actions/system-health"

interface ResponseTimeChartProps {
  criticalServices: string[]
}

const serviceColors: Record<string, string> = {
  supabase_db: "#3b82f6",
  anthropic: "#8b5cf6",
  sendgrid: "#14b8a6",
  twilio: "#22c55e",
  stripe: "#f59e0b",
  heygen: "#ec4899",
  vapi: "#06b6d4",
  dotloop: "#6366f1",
  docusign: "#f97316",
  quickbooks: "#84cc16",
  xero: "#0ea5e9",
}

type TimeRange = "1h" | "6h" | "24h" | "7d"

export function ResponseTimeChart({ criticalServices }: ResponseTimeChartProps) {
  const [timeRange, setTimeRange] = useState<TimeRange>("24h")
  const [selectedServices, setSelectedServices] = useState<string[]>(criticalServices)
  const [chartData, setChartData] = useState<{ time: string; [key: string]: string | number }[]>([])
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    const fetchData = async () => {
      setIsLoading(true)
      const hours = timeRange === "1h" ? 1 : timeRange === "6h" ? 6 : timeRange === "24h" ? 24 : 168
      const logs = await getResponseTimeLogs(selectedServices, hours)

      // Group logs by hour
      const grouped: Record<string, Record<string, number[]>> = {}
      logs.forEach((log) => {
        const hourKey = new Date(log.recorded_at).toISOString().slice(0, 13) + ":00"
        if (!grouped[hourKey]) grouped[hourKey] = {}
        if (!grouped[hourKey][log.service_key]) grouped[hourKey][log.service_key] = []
        grouped[hourKey][log.service_key].push(log.response_time_ms)
      })

      // Calculate averages
      const data = Object.entries(grouped)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([time, services]) => {
          const entry: { time: string; [key: string]: string | number } = {
            time: new Date(time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
          }
          Object.entries(services).forEach(([service, times]) => {
            entry[service] = Math.round(times.reduce((a, b) => a + b, 0) / times.length)
          })
          return entry
        })

      setChartData(data)
      setIsLoading(false)
    }

    fetchData()
  }, [timeRange, selectedServices])

  const toggleService = (serviceKey: string) => {
    setSelectedServices((prev) =>
      prev.includes(serviceKey)
        ? prev.filter((s) => s !== serviceKey)
        : [...prev, serviceKey]
    )
  }

  if (isLoading) {
    return (
      <div className="h-64 flex items-center justify-center text-muted-foreground">
        Loading chart data...
      </div>
    )
  }

  if (chartData.length === 0) {
    return (
      <div className="h-64 flex items-center justify-center text-muted-foreground">
        No response time data available for the selected time range
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex flex-wrap gap-2">
          {criticalServices.map((service) => (
            <button
              key={service}
              onClick={() => toggleService(service)}
              className={`text-xs px-2 py-1 rounded border transition-colors ${
                selectedServices.includes(service)
                  ? "border-primary bg-primary/10"
                  : "border-border bg-background opacity-50"
              }`}
              style={{
                borderColor: selectedServices.includes(service)
                  ? serviceColors[service] || "#888"
                  : undefined,
              }}
            >
              {service.replace(/_/g, " ")}
            </button>
          ))}
        </div>
        <Select value={timeRange} onValueChange={(v) => setTimeRange(v as TimeRange)}>
          <SelectTrigger className="w-24">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="1h">1 hour</SelectItem>
            <SelectItem value="6h">6 hours</SelectItem>
            <SelectItem value="24h">24 hours</SelectItem>
            <SelectItem value="7d">7 days</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
            <XAxis
              dataKey="time"
              tick={{ fontSize: 12 }}
              tickLine={false}
              axisLine={false}
            />
            <YAxis
              tick={{ fontSize: 12 }}
              tickLine={false}
              axisLine={false}
              tickFormatter={(value) => `${value}ms`}
            />
            <Tooltip
              formatter={(value: number) => [`${value}ms`, ""]}
              contentStyle={{
                backgroundColor: "hsl(var(--background))",
                border: "1px solid hsl(var(--border))",
                borderRadius: "6px",
              }}
            />
            <Legend />
            <ReferenceLine y={300} stroke="#22c55e" strokeDasharray="3 3" label="Good" />
            <ReferenceLine y={1000} stroke="#f59e0b" strokeDasharray="3 3" label="Slow" />
            {selectedServices.map((service) => (
              <Line
                key={service}
                type="monotone"
                dataKey={service}
                stroke={serviceColors[service] || "#888"}
                strokeWidth={2}
                dot={false}
                name={service.replace(/_/g, " ")}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}
