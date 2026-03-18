"use client"

import { useEffect, useState } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { AlertTriangle, Clock, CheckCircle, FileText, ArrowRight } from "lucide-react"
import { createClient } from "@/lib/supabase/client"
import Link from "next/link"

interface TitleCommandStripProps {
  titleCompanyId: string
}

interface PriorityAction {
  id: string
  type: "urgent" | "warning" | "info"
  title: string
  description: string
  cta: string
  href: string
  count?: number
}

export function TitleCommandStrip({ titleCompanyId }: TitleCommandStripProps) {
  const [actions, setActions] = useState<PriorityAction[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function loadPriorityActions() {
      const supabase = createClient()
      const priorityActions: PriorityAction[] = []

      // Check for title orders with issues
      const { data: issueOrders } = await supabase
        .from("title_orders")
        .select("id")
        .eq("vendor_id", titleCompanyId)
        .in("status", ["issue", "exception"])

      if (issueOrders && issueOrders.length > 0) {
        priorityActions.push({
          id: "issue-orders",
          type: "urgent",
          title: "Title Issues",
          description: `${issueOrders.length} orders have title issues`,
          cta: "Resolve Now",
          href: "/title/orders?filter=issues",
          count: issueOrders.length,
        })
      }

      // Check for closings in next 7 days
      const sevenDaysFromNow = new Date()
      sevenDaysFromNow.setDate(sevenDaysFromNow.getDate() + 7)
      
      const { data: upcomingClosings } = await supabase
        .from("title_orders")
        .select("id")
        .eq("vendor_id", titleCompanyId)
        .in("status", ["ordered", "in_progress", "clear"])
        .lte("closing_date", sevenDaysFromNow.toISOString())
        .gte("closing_date", new Date().toISOString())

      if (upcomingClosings && upcomingClosings.length > 0) {
        priorityActions.push({
          id: "upcoming-closings",
          type: "warning",
          title: "Upcoming Closings",
          description: `${upcomingClosings.length} closings in next 7 days`,
          cta: "View Schedule",
          href: "/title/closing",
          count: upcomingClosings.length,
        })
      }

      // Check for pending orders
      const { data: pendingOrders } = await supabase
        .from("title_orders")
        .select("id")
        .eq("vendor_id", titleCompanyId)
        .in("status", ["pending", "ordered"])

      if (pendingOrders && pendingOrders.length > 0) {
        priorityActions.push({
          id: "pending-orders",
          type: "info",
          title: "Pending Orders",
          description: `${pendingOrders.length} orders in progress`,
          cta: "View All",
          href: "/title/orders?filter=pending",
          count: pendingOrders.length,
        })
      }

      setActions(priorityActions)
      setLoading(false)
    }

    loadPriorityActions()
  }, [titleCompanyId])

  if (loading) {
    return (
      <Card className="border-primary/20 bg-gradient-to-r from-primary/5 to-transparent">
        <CardContent className="p-4">
          <div className="flex items-center gap-2">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            <span className="text-sm text-muted-foreground">Loading order status...</span>
          </div>
        </CardContent>
      </Card>
    )
  }

  if (actions.length === 0) {
    return (
      <Card className="border-green-500/20 bg-gradient-to-r from-green-500/5 to-transparent">
        <CardContent className="flex items-center gap-3 p-4">
          <CheckCircle className="h-5 w-5 text-green-500" />
          <span className="font-medium text-green-700">All orders on track - no pending issues</span>
        </CardContent>
      </Card>
    )
  }

  const primaryAction = actions[0]

  return (
    <Card className={`border-${primaryAction.type === "urgent" ? "destructive" : primaryAction.type === "warning" ? "yellow-500" : "primary"}/20 bg-gradient-to-r from-${primaryAction.type === "urgent" ? "destructive" : primaryAction.type === "warning" ? "yellow-500" : "primary"}/5 to-transparent`}>
      <CardContent className="p-4">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-4">
            {primaryAction.type === "urgent" && <AlertTriangle className="h-6 w-6 text-destructive" />}
            {primaryAction.type === "warning" && <Clock className="h-6 w-6 text-yellow-500" />}
            {primaryAction.type === "info" && <FileText className="h-6 w-6 text-primary" />}
            <div>
              <div className="flex items-center gap-2">
                <h3 className="font-semibold">{primaryAction.title}</h3>
                {primaryAction.count && (
                  <Badge variant={primaryAction.type === "urgent" ? "destructive" : "secondary"}>
                    {primaryAction.count}
                  </Badge>
                )}
              </div>
              <p className="text-sm text-muted-foreground">{primaryAction.description}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Link href={primaryAction.href}>
              <Button variant={primaryAction.type === "urgent" ? "destructive" : "default"} size="sm">
                {primaryAction.cta}
                <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </Link>
            {actions.length > 1 && (
              <Badge variant="outline" className="text-xs">
                +{actions.length - 1} more
              </Badge>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
