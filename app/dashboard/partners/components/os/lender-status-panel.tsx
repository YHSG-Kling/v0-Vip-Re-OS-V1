"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DollarSign, Clock, CheckCircle, AlertTriangle, ArrowRight } from "lucide-react"
import { createClient } from "@/lib/supabase/client"
import Link from "next/link"
import { VENDOR_CATEGORY_LENDER } from "@/lib/kernel/vendor-categories"

interface LenderStatusPanelProps {
  brokerageId: string
}

interface LenderMetrics {
  activeLenders: number
  pendingPreApprovals: number
  activeLoans: number
  avgProcessingDays: number
  recentUpdates: { id: string; lenderName: string; status: string; updatedAt: string }[]
}

export function LenderStatusPanel({ brokerageId }: LenderStatusPanelProps) {
  const [metrics, setMetrics] = useState<LenderMetrics | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function loadMetrics() {
      const supabase = createClient()

      // vendors.category is Title Case in the CHECK. This asked for 'lender'
      // and Postgres compares case-sensitively, so the panel showed 0 lenders.
      const { data: lenders, count: lenderCount } = await supabase
        .from("vendors")
        .select("id, name", { count: "exact" })
        .eq("brokerage_id", brokerageId)
        .eq("category", VENDOR_CATEGORY_LENDER)
        .eq("status", "active")

      // Get loan applications from lender_applications table
      const { data: loanApps } = await supabase
        .from("lender_applications")
        .select("id, status, lender_id, updated_at, vendors(name)")
        .eq("brokerage_id", brokerageId)
        .order("updated_at", { ascending: false })
        .limit(20)

      const pendingPreApprovals = loanApps?.filter((a: any) => a.status === "pending" || a.status === "pre_approval").length || 0
      const activeLoans = loanApps?.filter((a: any) => a.status === "active" || a.status === "processing").length || 0

      // Recent updates
      const recentUpdates = (loanApps || []).slice(0, 5).map((app: any) => ({
        id: app.id,
        lenderName: (app.vendors as any)?.name || "Unknown Lender",
        status: app.status,
        updatedAt: app.updated_at,
      }))

      setMetrics({
        activeLenders: lenderCount || 0,
        pendingPreApprovals,
        activeLoans,
        avgProcessingDays: 14, // Would need historical data to calculate
        recentUpdates,
      })
      setLoading(false)
    }

    loadMetrics()
  }, [brokerageId])

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Lender Status</CardTitle>
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

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "approved":
      case "active":
        return <CheckCircle className="h-3 w-3 text-green-500" />
      case "pending":
      case "pre_approval":
        return <Clock className="h-3 w-3 text-yellow-500" />
      case "denied":
      case "expired":
        return <AlertTriangle className="h-3 w-3 text-red-500" />
      default:
        return <Clock className="h-3 w-3 text-muted-foreground" />
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-lg">Lender Status</CardTitle>
            <CardDescription>Loan pipeline overview</CardDescription>
          </div>
          <Link href="/dashboard/vendors?category=lender">
            <Button variant="ghost" size="sm">
              Manage
              <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          </Link>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Key Metrics */}
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-lg bg-blue-50 p-3 dark:bg-blue-950/20">
            <DollarSign className="h-4 w-4 text-blue-600" />
            <p className="mt-1 text-xl font-bold text-blue-600">{metrics.activeLenders}</p>
            <p className="text-xs text-blue-600/70">Active Lenders</p>
          </div>
          <div className="rounded-lg bg-yellow-50 p-3 dark:bg-yellow-950/20">
            <Clock className="h-4 w-4 text-yellow-600" />
            <p className="mt-1 text-xl font-bold text-yellow-600">{metrics.pendingPreApprovals}</p>
            <p className="text-xs text-yellow-600/70">Pending Pre-Approvals</p>
          </div>
        </div>

        {/* Active Loans */}
        <div className="flex items-center justify-between rounded-lg bg-muted/50 p-3">
          <span className="text-sm font-medium">Active Loans in Pipeline</span>
          <Badge variant="secondary">{metrics.activeLoans}</Badge>
        </div>

        {/* Recent Updates */}
        {metrics.recentUpdates.length > 0 && (
          <div className="space-y-2">
            <span className="text-sm font-medium">Recent Updates</span>
            {metrics.recentUpdates.slice(0, 3).map(update => (
              <div key={update.id} className="flex items-center justify-between text-sm">
                <div className="flex items-center gap-2">
                  {getStatusIcon(update.status)}
                  <span className="truncate">{update.lenderName}</span>
                </div>
                <Badge variant="outline" className="text-xs capitalize">
                  {update.status.replace("_", " ")}
                </Badge>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
