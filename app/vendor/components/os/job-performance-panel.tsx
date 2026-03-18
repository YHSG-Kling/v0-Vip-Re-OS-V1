"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { Star, TrendingUp, Clock, CheckCircle } from "lucide-react"
import { createClient } from "@/lib/supabase/client"

interface JobPerformancePanelProps {
  vendorId: string
}

interface PerformanceMetrics {
  totalJobs: number
  completedJobs: number
  completionRate: number
  avgRating: number
  onTimeRate: number
  thisMonth: number
  lastMonth: number
}

export function JobPerformancePanel({ vendorId }: JobPerformancePanelProps) {
  const [metrics, setMetrics] = useState<PerformanceMetrics | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function loadMetrics() {
      const supabase = createClient()

      // Get all bookings for this vendor
      const { data: bookings } = await supabase
        .from("vendor_bookings")
        .select("id, status, created_at, completed_at, scheduled_date")
        .eq("vendor_id", vendorId)

      // Get vendor rating
      const { data: vendor } = await supabase
        .from("vendors")
        .select("rating")
        .eq("id", vendorId)
        .maybeSingle()

      if (!bookings) {
        setMetrics({
          totalJobs: 0,
          completedJobs: 0,
          completionRate: 0,
          avgRating: vendor?.rating || 0,
          onTimeRate: 0,
          thisMonth: 0,
          lastMonth: 0,
        })
        setLoading(false)
        return
      }

      const totalJobs = bookings.length
      const completedJobs = bookings.filter(b => b.status === "completed").length
      const completionRate = totalJobs > 0 ? (completedJobs / totalJobs) * 100 : 0

      // On-time calculation
      const onTimeJobs = bookings.filter(b => {
        if (b.status !== "completed" || !b.completed_at || !b.scheduled_date) return false
        return new Date(b.completed_at) <= new Date(b.scheduled_date)
      }).length
      const onTimeRate = completedJobs > 0 ? (onTimeJobs / completedJobs) * 100 : 0

      // Monthly comparison
      const now = new Date()
      const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1)
      const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1)
      
      const thisMonth = bookings.filter(b => new Date(b.created_at) >= thisMonthStart).length
      const lastMonth = bookings.filter(b => {
        const date = new Date(b.created_at)
        return date >= lastMonthStart && date < thisMonthStart
      }).length

      setMetrics({
        totalJobs,
        completedJobs,
        completionRate,
        avgRating: vendor?.rating || 0,
        onTimeRate,
        thisMonth,
        lastMonth,
      })
      setLoading(false)
    }

    loadMetrics()
  }, [vendorId])

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Job Performance</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-center py-8">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        </CardContent>
      </Card>
    )
  }

  if (!metrics) return null

  const trend = metrics.thisMonth - metrics.lastMonth
  const trendPercent = metrics.lastMonth > 0 ? ((trend / metrics.lastMonth) * 100).toFixed(0) : 0

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-lg">Job Performance</CardTitle>
        <CardDescription>Your performance metrics</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Rating */}
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">Your Rating</span>
          <div className="flex items-center gap-2">
            <Star className="h-4 w-4 fill-yellow-400 text-yellow-400" />
            <span className="font-bold">{metrics.avgRating.toFixed(1)}</span>
            <span className="text-sm text-muted-foreground">/ 5</span>
          </div>
        </div>

        {/* Completion Rate */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Completion Rate</span>
            <span className="text-sm font-bold">{metrics.completionRate.toFixed(0)}%</span>
          </div>
          <Progress value={metrics.completionRate} className="h-2" />
        </div>

        {/* On-Time Rate */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">On-Time Delivery</span>
            <span className="text-sm font-bold">{metrics.onTimeRate.toFixed(0)}%</span>
          </div>
          <Progress value={metrics.onTimeRate} className="h-2" />
        </div>

        {/* Stats Grid */}
        <div className="grid grid-cols-2 gap-3 pt-2">
          <div className="rounded-lg bg-green-50 p-3 dark:bg-green-950/20">
            <CheckCircle className="h-4 w-4 text-green-600" />
            <p className="mt-1 text-xl font-bold text-green-600">{metrics.completedJobs}</p>
            <p className="text-xs text-green-600/70">Completed</p>
          </div>
          <div className="rounded-lg bg-blue-50 p-3 dark:bg-blue-950/20">
            <TrendingUp className="h-4 w-4 text-blue-600" />
            <p className="mt-1 text-xl font-bold text-blue-600">{metrics.thisMonth}</p>
            <p className="text-xs text-blue-600/70">
              This Month {trend > 0 ? `+${trendPercent}%` : trend < 0 ? `${trendPercent}%` : ""}
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
