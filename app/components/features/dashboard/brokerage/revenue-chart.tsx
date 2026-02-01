"use client"

import { useEffect, useState } from "react"
import { createClient } from "@/lib/supabase/client"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts"
import { DollarSign } from "lucide-react"

interface RevenueData {
  month: string
  revenue: number
  target: number
}

export function BrokerageRevenueChart() {
  const [data, setData] = useState<RevenueData[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadRevenueData()
  }, [])

  const loadRevenueData = async () => {
    try {
      const supabase = createClient()
      const { data: transactions, error } = await supabase
        .from("transactions")
        .select("commission_amount, created_at")
        .gte("created_at", new Date(Date.now() - 12 * 30 * 24 * 60 * 60 * 1000).toISOString())

      if (error) throw error

      // Group by month
      const monthlyData: Record<string, number> = {}
      
      transactions?.forEach((t: any) => {
        const date = new Date(t.created_at)
        const month = date.toLocaleDateString("en-US", { month: "short", year: "2-digit" })
        monthlyData[month] = (monthlyData[month] || 0) + (t.commission_amount || 0)
      })

      const chartData = Object.entries(monthlyData).map(([month, revenue]) => ({
        month,
        revenue,
        target: 50000, // Example target
      }))

      setData(chartData)
    } catch (error) {
      console.error("Error loading revenue data:", error)
    } finally {
      setLoading(false)
    }
  }

  if (loading) {
    return <div className="text-center py-8">Loading chart...</div>
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <DollarSign className="w-5 h-5" />
          Monthly Revenue
        </CardTitle>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <p className="text-muted-foreground">No revenue data available</p>
        ) : (
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={data}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="month" />
              <YAxis />
              <Tooltip formatter={(value) => `$${value.toLocaleString()}`} />
              <Legend />
              <Bar dataKey="revenue" fill="#3b82f6" name="Actual Revenue" />
              <Bar dataKey="target" fill="#e5e7eb" name="Target" />
            </BarChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  )
}
