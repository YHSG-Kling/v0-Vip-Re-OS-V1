"use client"

import { useEffect, useState } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { 
  AlertTriangle, 
  UserPlus, 
  ClipboardCheck, 
  Settings,
  ChevronRight,
  Activity,
  Loader2
} from "lucide-react"
import Link from "next/link"
import { createClient } from "@/lib/supabase/client"

interface AdminCommandStripProps {
  brokerageId: string
}

interface AdminPriority {
  urgency: "critical" | "high" | "medium" | "low"
  label: string
  sublabel: string
  action: string
  href: string
  blocked: number
  actionable: number
}

export function AdminCommandStrip({ brokerageId }: AdminCommandStripProps) {
  const [priority, setPriority] = useState<AdminPriority | null>(null)
  const [loading, setLoading] = useState(true)
  const [confidence, setConfidence] = useState(0)

  useEffect(() => {
    async function loadPriority() {
      if (!brokerageId) {
        setLoading(false)
        return
      }

      const supabase = createClient()

      // Parallel fetch admin priority signals
      const [
        { count: pendingOnboarding },
        { count: pendingApprovals },
        { count: complianceAlerts },
        { count: providerIssues },
        { count: overdueTasks },
      ] = await Promise.all([
        supabase
          .from("agent_onboarding")
          .select("id", { count: "exact", head: true })
          .eq("brokerage_id", brokerageId)
          .in("status", ["pending", "in_progress"]),
        supabase
          .from("approval_items")
          .select("id", { count: "exact", head: true })
          .eq("brokerage_id", brokerageId)
          .eq("status", "pending"),
        supabase
          .from("compliance_events")
          .select("id", { count: "exact", head: true })
          .eq("brokerage_id", brokerageId)
          .eq("allowed", false),
        supabase
          .from("provider_overrides")
          .select("id", { count: "exact", head: true })
          .eq("scope_id", brokerageId)
          .eq("enabled", false),
        supabase
          .from("tasks")
          .select("id", { count: "exact", head: true })
          .eq("brokerage_id", brokerageId)
          .eq("status", "pending")
          .lt("due_date", new Date().toISOString().split("T")[0]),
      ])

      // Determine top priority
      const alerts = complianceAlerts || 0
      const approvals = pendingApprovals || 0
      const onboarding = pendingOnboarding || 0
      const providers = providerIssues || 0
      const tasks = overdueTasks || 0

      let topPriority: AdminPriority

      if (alerts > 0) {
        topPriority = {
          urgency: "critical",
          label: "Compliance Blocked",
          sublabel: `${alerts} compliance issue${alerts > 1 ? "s" : ""} require immediate attention`,
          action: "Review Alerts",
          href: "/dashboard/compliance",
          blocked: alerts,
          actionable: alerts,
        }
      } else if (approvals > 0) {
        topPriority = {
          urgency: "high",
          label: "Approvals Pending",
          sublabel: `${approvals} item${approvals > 1 ? "s" : ""} awaiting admin review`,
          action: "Review Now",
          href: "/dashboard/admin/approvals",
          blocked: 0,
          actionable: approvals,
        }
      } else if (onboarding > 0) {
        topPriority = {
          urgency: "medium",
          label: "Onboarding Active",
          sublabel: `${onboarding} agent${onboarding > 1 ? "s" : ""} in setup process`,
          action: "View Progress",
          href: "/dashboard/admin/onboarding",
          blocked: 0,
          actionable: onboarding,
        }
      } else if (tasks > 0) {
        topPriority = {
          urgency: "medium",
          label: "Tasks Overdue",
          sublabel: `${tasks} admin task${tasks > 1 ? "s" : ""} past due date`,
          action: "Review Tasks",
          href: "/dashboard/admin/tasks",
          blocked: 0,
          actionable: tasks,
        }
      } else {
        topPriority = {
          urgency: "low",
          label: "Operations Normal",
          sublabel: "All admin systems operating smoothly",
          action: "View Dashboard",
          href: "/dashboard/admin",
          blocked: 0,
          actionable: 0,
        }
      }

      // Calculate operational confidence (0-100)
      const totalIssues = alerts + approvals + onboarding + providers + tasks
      const conf = Math.max(0, 100 - totalIssues * 10)
      setConfidence(conf)

      setPriority(topPriority)
      setLoading(false)
    }

    loadPriority()
  }, [brokerageId])

  if (loading) {
    return (
      <Card className="border-border bg-muted/30">
        <CardContent className="flex items-center justify-center p-6">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    )
  }

  if (!priority) return null

  const urgencyColors = {
    critical: "border-red-500 bg-red-50",
    high: "border-amber-500 bg-amber-50",
    medium: "border-blue-500 bg-blue-50",
    low: "border-emerald-500 bg-emerald-50",
  }

  const urgencyTextColors = {
    critical: "text-red-700",
    high: "text-amber-700",
    medium: "text-blue-700",
    low: "text-emerald-700",
  }

  const urgencyBadgeColors = {
    critical: "destructive",
    high: "secondary",
    medium: "outline",
    low: "outline",
  } as const

  return (
    <Card className={`border-l-4 ${urgencyColors[priority.urgency]}`}>
      <CardContent className="p-4">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className={`p-2 rounded-lg ${priority.urgency === "critical" ? "bg-red-100" : priority.urgency === "high" ? "bg-amber-100" : priority.urgency === "medium" ? "bg-blue-100" : "bg-emerald-100"}`}>
              {priority.urgency === "critical" ? (
                <AlertTriangle className={`h-5 w-5 ${urgencyTextColors[priority.urgency]}`} />
              ) : priority.urgency === "high" ? (
                <ClipboardCheck className={`h-5 w-5 ${urgencyTextColors[priority.urgency]}`} />
              ) : priority.urgency === "medium" ? (
                <UserPlus className={`h-5 w-5 ${urgencyTextColors[priority.urgency]}`} />
              ) : (
                <Activity className={`h-5 w-5 ${urgencyTextColors[priority.urgency]}`} />
              )}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <p className={`font-semibold ${urgencyTextColors[priority.urgency]}`}>
                  {priority.label}
                </p>
                {priority.blocked > 0 && (
                  <Badge variant="destructive" className="text-xs">
                    {priority.blocked} Blocked
                  </Badge>
                )}
              </div>
              <p className="text-sm text-muted-foreground">{priority.sublabel}</p>
            </div>
          </div>

          <div className="flex items-center gap-4">
            <div className="hidden md:flex items-center gap-2 text-sm text-muted-foreground">
              <Activity className="h-4 w-4" />
              <span>Operational Confidence: {confidence}%</span>
            </div>
            <Link href={priority.href}>
              <Button 
                variant={priority.urgency === "critical" ? "destructive" : priority.urgency === "high" ? "default" : "outline"}
                size="sm"
                className="gap-1"
              >
                {priority.action}
                <ChevronRight className="h-4 w-4" />
              </Button>
            </Link>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
