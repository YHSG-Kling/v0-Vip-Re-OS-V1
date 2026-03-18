"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { DollarSign, TrendingUp, Clock, CheckCircle, XCircle } from "lucide-react"
import { createClient } from "@/lib/supabase/client"

interface LenderPipelinePanelProps {
  lenderId: string
}

interface PipelineMetrics {
  totalApplications: number
  approved: number
  pending: number
  denied: number
  approvalRate: number
  totalVolume: number
  avgProcessingDays: number
}

export function LenderPipelinePanel({ lenderId }: LenderPipelinePanelProps) {
  const [metrics, setMetrics] = useState<PipelineMetrics | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function loadMetrics() {
      const supabase = createClient()

      // Get all applications for this lender
      const { data: applications } = await supabase
        .from("lender_applications")
        .select("id, status, loan_amount, created_at, approved_at")
        .eq("lender_id", lenderId)

      if (!applications || applications.length === 0) {
        setMetrics({
          totalApplications: 0,
          approved: 0,
          pending: 0,
          denied: 0,
          approvalRate: 0,
          totalVolume: 0,
          avgProcessingDays: 0,
        })
        setLoading(false)
        return
      }

      const totalApplications = applications.length
      const approved = applications.filter(a => a.status === "approved" || a.status === "funded").length
      const pending = applications.filter(a => ["pending", "processing", "underwriting"].includes(a.status)).length
      const denied = applications.filter(a => a.status === "denied").length
      
      const decisioned = approved + denied
      const approvalRate = decisioned > 0 ? (approved / decisioned) * 100 : 0

      const totalVolume = applications
        .filter(a => a.status === "approved" || a.status === "funded")
        .reduce((sum, a) => sum + (a.loan_amount || 0), 0)

      // Calculate avg processing time for approved loans
      const processedLoans = applications.filter(a => a.approved_at && a.created_at)
      const avgProcessingDays = processedLoans.length > 0
        ? processedLoans.reduce((sum, a) => {
            const days = (new Date(a.approved_at).getTime() - new Date(a.created_at).getTime()) / (1000 * 60 * 60 * 24)
            return sum + days
          }, 0) / processedLoans.length
        : 0

      setMetrics({
        totalApplications,
        approved,
        pending,
        denied,
        approvalRate,
        totalVolume,
        avgProcessingDays,
      })
      setLoading(false)
    }

    loadMetrics()
  }, [lenderId])

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Pipeline Overview</CardTitle>
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

  const formatCurrency = (value: number) => 
    new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value)

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-lg">Pipeline Overview</CardTitle>
        <CardDescription>Loan application metrics</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Approval Rate */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Approval Rate</span>
            <span className="text-sm font-bold">{metrics.approvalRate.toFixed(0)}%</span>
          </div>
          <Progress value={metrics.approvalRate} className="h-2" />
        </div>

        {/* Status Breakdown */}
        <div className="grid grid-cols-3 gap-2">
          <div className="flex flex-col items-center rounded-lg bg-green-50 p-2 dark:bg-green-950/20">
            <CheckCircle className="h-4 w-4 text-green-600" />
            <span className="mt-1 text-lg font-bold text-green-600">{metrics.approved}</span>
            <span className="text-xs text-green-600/70">Approved</span>
          </div>
          <div className="flex flex-col items-center rounded-lg bg-yellow-50 p-2 dark:bg-yellow-950/20">
            <Clock className="h-4 w-4 text-yellow-600" />
            <span className="mt-1 text-lg font-bold text-yellow-600">{metrics.pending}</span>
            <span className="text-xs text-yellow-600/70">Pending</span>
          </div>
          <div className="flex flex-col items-center rounded-lg bg-red-50 p-2 dark:bg-red-950/20">
            <XCircle className="h-4 w-4 text-red-600" />
            <span className="mt-1 text-lg font-bold text-red-600">{metrics.denied}</span>
            <span className="text-xs text-red-600/70">Denied</span>
          </div>
        </div>

        {/* Volume & Processing */}
        <div className="space-y-2 pt-2">
          <div className="flex items-center justify-between text-sm">
            <span className="flex items-center gap-2">
              <DollarSign className="h-4 w-4 text-muted-foreground" />
              Total Volume
            </span>
            <Badge variant="secondary">{formatCurrency(metrics.totalVolume)}</Badge>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-muted-foreground" />
              Avg Processing
            </span>
            <Badge variant="outline">{metrics.avgProcessingDays.toFixed(1)} days</Badge>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
