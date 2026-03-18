"use client"

import { useEffect, useState } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { AlertTriangle, Clock, CheckCircle, DollarSign, ArrowRight } from "lucide-react"
import { createClient } from "@/lib/supabase/client"
import Link from "next/link"

interface LenderCommandStripProps {
  lenderId: string
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

export function LenderCommandStrip({ lenderId }: LenderCommandStripProps) {
  const [actions, setActions] = useState<PriorityAction[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function loadPriorityActions() {
      const supabase = createClient()
      const priorityActions: PriorityAction[] = []

      // Check for pending loan applications
      const { data: pendingApps } = await supabase
        .from("lender_applications")
        .select("id")
        .eq("lender_id", lenderId)
        .eq("status", "pending")

      if (pendingApps && pendingApps.length > 0) {
        priorityActions.push({
          id: "pending-apps",
          type: "urgent",
          title: "Pending Applications",
          description: `${pendingApps.length} applications need review`,
          cta: "Review Now",
          href: "/lender/approvals?filter=pending",
          count: pendingApps.length,
        })
      }

      // Check for applications needing documents
      const { data: docsNeeded } = await supabase
        .from("lender_applications")
        .select("id")
        .eq("lender_id", lenderId)
        .eq("status", "docs_needed")

      if (docsNeeded && docsNeeded.length > 0) {
        priorityActions.push({
          id: "docs-needed",
          type: "warning",
          title: "Documents Needed",
          description: `${docsNeeded.length} applications awaiting documents`,
          cta: "View",
          href: "/lender/documents?filter=needed",
          count: docsNeeded.length,
        })
      }

      // Check for active loans
      const { data: activeLoans } = await supabase
        .from("lender_applications")
        .select("id")
        .eq("lender_id", lenderId)
        .in("status", ["approved", "processing", "underwriting"])

      if (activeLoans && activeLoans.length > 0) {
        priorityActions.push({
          id: "active-loans",
          type: "info",
          title: "Active Pipeline",
          description: `${activeLoans.length} loans in progress`,
          cta: "View Pipeline",
          href: "/lender/pipeline",
          count: activeLoans.length,
        })
      }

      setActions(priorityActions)
      setLoading(false)
    }

    loadPriorityActions()
  }, [lenderId])

  if (loading) {
    return (
      <Card className="border-primary/20 bg-gradient-to-r from-primary/5 to-transparent">
        <CardContent className="p-4">
          <div className="flex items-center gap-2">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            <span className="text-sm text-muted-foreground">Loading pipeline status...</span>
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
          <span className="font-medium text-green-700">Pipeline clear - no pending actions</span>
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
            {primaryAction.type === "info" && <DollarSign className="h-6 w-6 text-primary" />}
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
