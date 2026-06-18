"use client"

import { useEffect, useState } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { AlertTriangle, Clock, CheckCircle, Users, ArrowRight } from "lucide-react"
import { createClient } from "@/lib/supabase/client"
import Link from "next/link"

interface PartnerCommandStripProps {
  brokerageId: string
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

export function PartnerCommandStrip({ brokerageId }: PartnerCommandStripProps) {
  const [actions, setActions] = useState<PriorityAction[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function loadPriorityActions() {
      const supabase = createClient()
      const priorityActions: PriorityAction[] = []

      // Check for vendors with low ratings
      const { data: lowRatedVendors } = await supabase
        .from("vendors")
        .select("id")
        .eq("brokerage_id", brokerageId)
        .lt("rating", 3)
        .eq("status", "active")

      if (lowRatedVendors && lowRatedVendors.length > 0) {
        priorityActions.push({
          id: "low-rated",
          type: "urgent",
          title: "Low-Rated Vendors",
          description: `${lowRatedVendors.length} vendors below 3-star rating`,
          cta: "Review Now",
          href: "/dashboard/vendors?filter=low-rated",
          count: lowRatedVendors.length,
        })
      }

      // Check for pending vendor approvals
      const { data: pendingVendors } = await supabase
        .from("vendors")
        .select("id")
        .eq("brokerage_id", brokerageId)
        .eq("status", "pending")

      if (pendingVendors && pendingVendors.length > 0) {
        priorityActions.push({
          id: "pending-approval",
          type: "warning",
          title: "Pending Approvals",
          description: `${pendingVendors.length} vendors awaiting approval`,
          cta: "Approve",
          href: "/dashboard/vendors?filter=pending",
          count: pendingVendors.length,
        })
      }

      // (Expiring-contracts surfacing removed: vendors has no contract_end_date column / data source.)

      // Check total active vendors
      const { count: activeCount } = await supabase
        .from("vendors")
        .select("id", { count: "exact", head: true })
        .eq("brokerage_id", brokerageId)
        .eq("status", "active")

      if (activeCount && activeCount > 0) {
        priorityActions.push({
          id: "active-vendors",
          type: "info",
          title: "Active Partners",
          description: `${activeCount} vendors in your network`,
          cta: "View All",
          href: "/dashboard/vendors",
          count: activeCount,
        })
      }

      setActions(priorityActions)
      setLoading(false)
    }

    loadPriorityActions()
  }, [brokerageId])

  if (loading) {
    return (
      <Card className="border-primary/20 bg-gradient-to-r from-primary/5 to-transparent">
        <CardContent className="p-4">
          <div className="flex items-center gap-2">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            <span className="text-sm text-muted-foreground">Loading partner intelligence...</span>
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
          <span className="font-medium text-green-700">All partner relationships healthy</span>
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
            {primaryAction.type === "info" && <Users className="h-6 w-6 text-primary" />}
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
