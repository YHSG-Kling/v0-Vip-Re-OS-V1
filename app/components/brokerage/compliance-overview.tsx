"use client"

import { useEffect, useState } from "react"
import { createClient } from "@/lib/supabase/client"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { AlertCircle, CheckCircle2, Clock } from "lucide-react"

interface ComplianceMetrics {
  total_audits: number
  passed: number
  failed: number
  pending: number
  pass_rate: number
}

export function BrokerageComplianceOverview() {
  const [metrics, setMetrics] = useState<ComplianceMetrics | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadComplianceMetrics()
  }, [])

  const loadComplianceMetrics = async () => {
    try {
      const supabase = createClient()
      const { data, error } = await supabase
        .from("compliance_audits")
        .select("status")

      if (error) throw error

      const audits = data || []
      // Normalized status values: pending, pass, fail, waived, needs_review
      const passed = audits.filter((a: any) => a.status === "pass").length
      const failed = audits.filter((a: any) => a.status === "fail").length
      const pending = audits.filter((a: any) => a.status === "pending" || a.status === "needs_review").length

      setMetrics({
        total_audits: audits.length,
        passed,
        failed,
        pending,
        pass_rate: audits.length > 0 ? (passed / audits.length) * 100 : 0,
      })
    } catch (error) {
      console.error("Error loading compliance metrics:", error)
    } finally {
      setLoading(false)
    }
  }

  if (loading) {
    return <div className="text-center py-8">Loading compliance data...</div>
  }

  if (!metrics) {
    return <div className="text-center py-8">No compliance data available</div>
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <AlertCircle className="w-5 h-5" />
          Compliance Overview
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <div className="p-4 border rounded-lg">
            <p className="text-sm text-muted-foreground">Total Audits</p>
            <p className="text-2xl font-bold">{metrics.total_audits}</p>
          </div>
          <div className="p-4 border rounded-lg border-green-200 bg-green-50">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-green-600" />
              <div>
                <p className="text-sm text-muted-foreground">Passed</p>
                <p className="text-2xl font-bold text-green-600">{metrics.passed}</p>
              </div>
            </div>
          </div>
          <div className="p-4 border rounded-lg border-red-200 bg-red-50">
            <div className="flex items-center gap-2">
              <AlertCircle className="w-4 h-4 text-red-600" />
              <div>
                <p className="text-sm text-muted-foreground">Failed</p>
                <p className="text-2xl font-bold text-red-600">{metrics.failed}</p>
              </div>
            </div>
          </div>
          <div className="p-4 border rounded-lg border-yellow-200 bg-yellow-50">
            <div className="flex items-center gap-2">
              <Clock className="w-4 h-4 text-yellow-600" />
              <div>
                <p className="text-sm text-muted-foreground">Pending</p>
                <p className="text-2xl font-bold text-yellow-600">{metrics.pending}</p>
              </div>
            </div>
          </div>
        </div>
        <div className="mt-6 p-4 bg-slate-100 rounded-lg">
          <p className="text-sm text-muted-foreground">Pass Rate</p>
          <p className="text-3xl font-bold">{metrics.pass_rate.toFixed(1)}%</p>
        </div>
      </CardContent>
    </Card>
  )
}
