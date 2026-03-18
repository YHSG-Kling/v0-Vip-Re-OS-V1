"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { FileText, Clock, CheckCircle, AlertTriangle, ArrowRight } from "lucide-react"
import { createClient } from "@/lib/supabase/client"
import Link from "next/link"

interface TitlePipelinePanelProps {
  brokerageId: string
}

interface TitleMetrics {
  activeTitleCompanies: number
  pendingTitleOrders: number
  titleClears: number
  titleIssues: number
  recentOrders: { id: string; propertyAddress: string; status: string; companyName: string }[]
}

export function TitlePipelinePanel({ brokerageId }: TitlePipelinePanelProps) {
  const [metrics, setMetrics] = useState<TitleMetrics | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function loadMetrics() {
      const supabase = createClient()

      // Get active title companies (vendors with category = 'title')
      const { count: titleCompanyCount } = await supabase
        .from("vendors")
        .select("id", { count: "exact", head: true })
        .eq("brokerage_id", brokerageId)
        .eq("category", "title")
        .eq("status", "active")

      // Get title orders from title_orders table
      const { data: titleOrders } = await supabase
        .from("title_orders")
        .select("id, status, property_address, vendor_id, created_at, vendors(name)")
        .eq("brokerage_id", brokerageId)
        .order("created_at", { ascending: false })
        .limit(20)

      const pendingTitleOrders = titleOrders?.filter(o => 
        o.status === "pending" || o.status === "ordered" || o.status === "in_progress"
      ).length || 0
      
      const titleClears = titleOrders?.filter(o => o.status === "clear" || o.status === "completed").length || 0
      const titleIssues = titleOrders?.filter(o => o.status === "issue" || o.status === "exception").length || 0

      // Recent orders
      const recentOrders = (titleOrders || []).slice(0, 5).map(order => ({
        id: order.id,
        propertyAddress: order.property_address || "Unknown Property",
        status: order.status,
        companyName: (order.vendors as any)?.name || "Unknown Title Co",
      }))

      setMetrics({
        activeTitleCompanies: titleCompanyCount || 0,
        pendingTitleOrders,
        titleClears,
        titleIssues,
        recentOrders,
      })
      setLoading(false)
    }

    loadMetrics()
  }, [brokerageId])

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Title Pipeline</CardTitle>
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

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "clear":
      case "completed":
        return <Badge className="bg-green-100 text-green-700 dark:bg-green-900/20">Clear</Badge>
      case "pending":
      case "ordered":
        return <Badge className="bg-yellow-100 text-yellow-700 dark:bg-yellow-900/20">Pending</Badge>
      case "in_progress":
        return <Badge className="bg-blue-100 text-blue-700 dark:bg-blue-900/20">In Progress</Badge>
      case "issue":
      case "exception":
        return <Badge className="bg-red-100 text-red-700 dark:bg-red-900/20">Issue</Badge>
      default:
        return <Badge variant="outline">{status}</Badge>
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-lg">Title Pipeline</CardTitle>
            <CardDescription>Title order status tracking</CardDescription>
          </div>
          <Link href="/dashboard/vendors?category=title">
            <Button variant="ghost" size="sm">
              View All
              <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          </Link>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Key Metrics */}
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-lg bg-purple-50 p-3 dark:bg-purple-950/20">
            <FileText className="h-4 w-4 text-purple-600" />
            <p className="mt-1 text-xl font-bold text-purple-600">{metrics.activeTitleCompanies}</p>
            <p className="text-xs text-purple-600/70">Title Companies</p>
          </div>
          <div className="rounded-lg bg-yellow-50 p-3 dark:bg-yellow-950/20">
            <Clock className="h-4 w-4 text-yellow-600" />
            <p className="mt-1 text-xl font-bold text-yellow-600">{metrics.pendingTitleOrders}</p>
            <p className="text-xs text-yellow-600/70">Pending Orders</p>
          </div>
        </div>

        {/* Status Summary */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 rounded-lg bg-green-50 px-3 py-2 dark:bg-green-950/20">
            <CheckCircle className="h-4 w-4 text-green-600" />
            <span className="text-sm font-medium text-green-700">{metrics.titleClears} Clear</span>
          </div>
          {metrics.titleIssues > 0 && (
            <div className="flex items-center gap-2 rounded-lg bg-red-50 px-3 py-2 dark:bg-red-950/20">
              <AlertTriangle className="h-4 w-4 text-red-600" />
              <span className="text-sm font-medium text-red-700">{metrics.titleIssues} Issues</span>
            </div>
          )}
        </div>

        {/* Recent Orders */}
        {metrics.recentOrders.length > 0 && (
          <div className="space-y-2">
            <span className="text-sm font-medium">Recent Orders</span>
            {metrics.recentOrders.slice(0, 3).map(order => (
              <div key={order.id} className="flex items-center justify-between text-sm">
                <span className="truncate max-w-[150px]">{order.propertyAddress}</span>
                {getStatusBadge(order.status)}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
