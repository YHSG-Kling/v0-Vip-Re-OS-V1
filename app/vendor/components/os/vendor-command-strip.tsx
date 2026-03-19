"use client"

import { useEffect, useState } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { AlertTriangle, Clock, CheckCircle, Briefcase, ArrowRight } from "lucide-react"
import { createClient } from "@/lib/supabase/client"
import Link from "next/link"

interface VendorCommandStripProps {
  vendorId: string
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

export function VendorCommandStrip({ vendorId }: VendorCommandStripProps) {
  const [actions, setActions] = useState<PriorityAction[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function loadPriorityActions() {
      const supabase = createClient()
      const priorityActions: PriorityAction[] = []

      // Check for pending job requests
      const { data: pendingJobs } = await supabase
        .from("vendor_bookings")
        .select("id")
        .eq("vendor_id", vendorId)
        .eq("status", "pending")

      if (pendingJobs && pendingJobs.length > 0) {
        priorityActions.push({
          id: "pending-jobs",
          type: "urgent",
          title: "New Job Requests",
          description: `${pendingJobs.length} jobs awaiting your response`,
          cta: "Review Now",
          href: "/vendor/jobs?filter=pending",
          count: pendingJobs.length,
        })
      }

      // Check for scheduled jobs today
      const today = new Date().toISOString().split("T")[0]
      const { data: todayJobs } = await supabase
        .from("vendor_bookings")
        .select("id")
        .eq("vendor_id", vendorId)
        .eq("status", "scheduled")
        .gte("scheduled_date", today)
        .lt("scheduled_date", today + "T23:59:59")

      if (todayJobs && todayJobs.length > 0) {
        priorityActions.push({
          id: "today-jobs",
          type: "warning",
          title: "Jobs Today",
          description: `${todayJobs.length} jobs scheduled for today`,
          cta: "View Schedule",
          href: "/vendor/jobs?filter=today",
          count: todayJobs.length,
        })
      }

      // Check for active jobs
      const { data: activeJobs } = await supabase
        .from("vendor_bookings")
        .select("id")
        .eq("vendor_id", vendorId)
        .in("status", ["active", "in_progress"])

      if (activeJobs && activeJobs.length > 0) {
        priorityActions.push({
          id: "active-jobs",
          type: "info",
          title: "Active Jobs",
          description: `${activeJobs.length} jobs in progress`,
          cta: "View All",
          href: "/vendor/jobs?filter=active",
          count: activeJobs.length,
        })
      }

      setActions(priorityActions)
      setLoading(false)
    }

    loadPriorityActions()
  }, [vendorId])

  if (loading) {
    return (
      <Card className="border-primary/20 bg-gradient-to-r from-primary/5 to-transparent">
        <CardContent className="p-4">
          <div className="flex items-center gap-2">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            <span className="text-sm text-muted-foreground">Loading job status...</span>
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
          <span className="font-medium text-green-700">All caught up - no pending actions</span>
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
            {primaryAction.type === "info" && <Briefcase className="h-6 w-6 text-primary" />}
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
