"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { CheckCircle, AlertTriangle, Clock } from "lucide-react"
import { createClient } from "@/lib/supabase/client"

interface VendorSlaPanelProps {
  brokerageId: string
}

interface SlaMetrics {
  overallCompliance: number
  onTimeDelivery: number
  responseTime: number
  qualityScore: number
  vendorsByCompliance: { compliant: number; warning: number; breach: number }
}

export function VendorSlaPanel({ brokerageId }: VendorSlaPanelProps) {
  const [metrics, setMetrics] = useState<SlaMetrics | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function loadMetrics() {
      const supabase = createClient()

      // Get vendors with their SLA data
      const { data: vendors } = await supabase
        .from("vendors")
        .select("id, rating, response_time_hours, on_time_delivery_pct")
        .eq("brokerage_id", brokerageId)
        .eq("status", "active")

      if (!vendors || vendors.length === 0) {
        setMetrics({
          overallCompliance: 0,
          onTimeDelivery: 0,
          responseTime: 0,
          qualityScore: 0,
          vendorsByCompliance: { compliant: 0, warning: 0, breach: 0 },
        })
        setLoading(false)
        return
      }

      // Calculate metrics
      const avgRating = vendors.reduce((sum: any, v: any) => sum + (v.rating || 0), 0) / vendors.length
      const avgOnTimeDelivery = vendors.reduce((sum: any, v: any) => sum + (v.on_time_delivery_pct || 85), 0) / vendors.length
      const avgResponseTime = vendors.reduce((sum: any, v: any) => sum + (v.response_time_hours || 24), 0) / vendors.length

      // SLA compliance calculation
      const compliant = vendors.filter((v: any) => (v.rating || 0) >= 4 && (v.on_time_delivery_pct || 85) >= 90).length
      const warning = vendors.filter((v: any) => {
        const rating = v.rating || 0
        const delivery = v.on_time_delivery_pct || 85
        return (rating >= 3 && rating < 4) || (delivery >= 75 && delivery < 90)
      }).length
      const breach = vendors.filter((v: any) => (v.rating || 0) < 3 || (v.on_time_delivery_pct || 85) < 75).length

      const overallCompliance = vendors.length > 0 ? (compliant / vendors.length) * 100 : 0

      setMetrics({
        overallCompliance,
        onTimeDelivery: avgOnTimeDelivery,
        responseTime: avgResponseTime,
        qualityScore: (avgRating / 5) * 100,
        vendorsByCompliance: { compliant, warning, breach },
      })
      setLoading(false)
    }

    loadMetrics()
  }, [brokerageId])

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">SLA Compliance</CardTitle>
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

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-lg">SLA Compliance</CardTitle>
        <CardDescription>Vendor performance against SLA targets</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Overall Compliance */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Overall Compliance</span>
            <span className="font-bold">{metrics.overallCompliance.toFixed(0)}%</span>
          </div>
          <Progress value={metrics.overallCompliance} className="h-2" />
        </div>

        {/* Compliance Breakdown */}
        <div className="grid grid-cols-3 gap-2">
          <div className="flex flex-col items-center rounded-lg bg-green-50 p-2 dark:bg-green-950/20">
            <CheckCircle className="h-4 w-4 text-green-600" />
            <span className="mt-1 text-lg font-bold text-green-600">{metrics.vendorsByCompliance.compliant}</span>
            <span className="text-xs text-green-600/70">Compliant</span>
          </div>
          <div className="flex flex-col items-center rounded-lg bg-yellow-50 p-2 dark:bg-yellow-950/20">
            <Clock className="h-4 w-4 text-yellow-600" />
            <span className="mt-1 text-lg font-bold text-yellow-600">{metrics.vendorsByCompliance.warning}</span>
            <span className="text-xs text-yellow-600/70">Warning</span>
          </div>
          <div className="flex flex-col items-center rounded-lg bg-red-50 p-2 dark:bg-red-950/20">
            <AlertTriangle className="h-4 w-4 text-red-600" />
            <span className="mt-1 text-lg font-bold text-red-600">{metrics.vendorsByCompliance.breach}</span>
            <span className="text-xs text-red-600/70">Breach</span>
          </div>
        </div>

        {/* Metric Details */}
        <div className="space-y-3">
          <div className="flex items-center justify-between text-sm">
            <span>On-Time Delivery</span>
            <Badge variant={metrics.onTimeDelivery >= 90 ? "default" : "secondary"}>
              {metrics.onTimeDelivery.toFixed(0)}%
            </Badge>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span>Avg Response Time</span>
            <Badge variant={metrics.responseTime <= 24 ? "default" : "secondary"}>
              {metrics.responseTime.toFixed(0)}h
            </Badge>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span>Quality Score</span>
            <Badge variant={metrics.qualityScore >= 80 ? "default" : "secondary"}>
              {metrics.qualityScore.toFixed(0)}%
            </Badge>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
