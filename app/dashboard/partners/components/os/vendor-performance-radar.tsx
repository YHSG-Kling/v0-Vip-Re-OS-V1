"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Star, TrendingUp, TrendingDown, Minus } from "lucide-react"
import { createClient } from "@/lib/supabase/client"

interface VendorPerformanceRadarProps {
  brokerageId: string
}

interface VendorMetrics {
  totalVendors: number
  avgRating: number
  topPerformers: number
  underPerformers: number
  byCategory: { category: string; count: number; avgRating: number }[]
}

export function VendorPerformanceRadar({ brokerageId }: VendorPerformanceRadarProps) {
  const [metrics, setMetrics] = useState<VendorMetrics | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function loadMetrics() {
      const supabase = createClient()

      // Get all active vendors
      const { data: vendors } = await supabase
        .from("vendors")
        .select("id, category, rating, status")
        .eq("brokerage_id", brokerageId)
        .eq("status", "active")

      if (!vendors || vendors.length === 0) {
        setMetrics({
          totalVendors: 0,
          avgRating: 0,
          topPerformers: 0,
          underPerformers: 0,
          byCategory: [],
        })
        setLoading(false)
        return
      }

      // Calculate metrics
      const totalVendors = vendors.length
      const avgRating = vendors.reduce((sum: number, v: any) => sum + (v.rating || 0), 0) / totalVendors
      const topPerformers = vendors.filter((v: any) => (v.rating || 0) >= 4).length
      const underPerformers = vendors.filter((v: any) => (v.rating || 0) < 3).length

      // Group by category
      const categoryMap = new Map<string, { count: number; totalRating: number }>()
      vendors.forEach((v: any) => {
        const cat = v.category || "Other"
        const existing = categoryMap.get(cat) || { count: 0, totalRating: 0 }
        categoryMap.set(cat, {
          count: existing.count + 1,
          totalRating: existing.totalRating + (v.rating || 0),
        })
      })

      const byCategory = Array.from(categoryMap.entries())
        .map(([category, data]) => ({
          category,
          count: data.count,
          avgRating: data.totalRating / data.count,
        }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 5)

      setMetrics({
        totalVendors,
        avgRating,
        topPerformers,
        underPerformers,
        byCategory,
      })
      setLoading(false)
    }

    loadMetrics()
  }, [brokerageId])

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Vendor Performance</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-center py-8">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        </CardContent>
      </Card>
    )
  }

  if (!metrics || metrics.totalVendors === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Vendor Performance</CardTitle>
          <CardDescription>No active vendors in your network</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">Add vendors to see performance metrics.</p>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-lg">Vendor Performance</CardTitle>
        <CardDescription>{metrics.totalVendors} active vendors</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Average Rating */}
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">Network Rating</span>
          <div className="flex items-center gap-2">
            <Star className="h-4 w-4 fill-yellow-400 text-yellow-400" />
            <span className="font-bold">{metrics.avgRating.toFixed(1)}</span>
            <span className="text-sm text-muted-foreground">/ 5</span>
          </div>
        </div>

        {/* Performance Distribution */}
        <div className="grid grid-cols-2 gap-4">
          <div className="rounded-lg bg-green-50 p-3 dark:bg-green-950/20">
            <div className="flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-green-600" />
              <span className="text-sm text-green-700 dark:text-green-400">Top Performers</span>
            </div>
            <p className="mt-1 text-2xl font-bold text-green-600">{metrics.topPerformers}</p>
            <p className="text-xs text-green-600/70">4+ star rating</p>
          </div>
          <div className="rounded-lg bg-red-50 p-3 dark:bg-red-950/20">
            <div className="flex items-center gap-2">
              <TrendingDown className="h-4 w-4 text-red-600" />
              <span className="text-sm text-red-700 dark:text-red-400">Needs Review</span>
            </div>
            <p className="mt-1 text-2xl font-bold text-red-600">{metrics.underPerformers}</p>
            <p className="text-xs text-red-600/70">Below 3 stars</p>
          </div>
        </div>

        {/* By Category */}
        <div className="space-y-2">
          <span className="text-sm font-medium">By Category</span>
          {metrics.byCategory.map(cat => (
            <div key={cat.category} className="flex items-center justify-between text-sm">
              <div className="flex items-center gap-2">
                <span className="capitalize">{cat.category}</span>
                <Badge variant="secondary" className="text-xs">{cat.count}</Badge>
              </div>
              <div className="flex items-center gap-1">
                <Star className="h-3 w-3 fill-yellow-400 text-yellow-400" />
                <span>{cat.avgRating.toFixed(1)}</span>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
