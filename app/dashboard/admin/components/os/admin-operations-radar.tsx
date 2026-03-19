"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { 
  UserPlus, 
  Settings,
  GitBranch,
  AlertCircle,
  CheckCircle2,
  Loader2,
  ListChecks
} from "lucide-react"
import { createClient } from "@/lib/supabase/client"

interface AdminOperationsRadarProps {
  brokerageId: string
}

interface OperationsData {
  onboardingActive: number
  onboardingStuck: number
  incompleteSetups: number
  providerIssues: number
  assignmentPressure: number
  adminBacklog: number
}

export function AdminOperationsRadar({ brokerageId }: AdminOperationsRadarProps) {
  const [data, setData] = useState<OperationsData | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function loadOperations() {
      if (!brokerageId) {
        setLoading(false)
        return
      }

      const supabase = createClient()
      const weekAgo = new Date()
      weekAgo.setDate(weekAgo.getDate() - 7)

      const [
        { data: onboarding },
        { count: incompleteSetups },
        { count: providerIssues },
        { data: assignmentLog },
        { count: adminBacklog },
      ] = await Promise.all([
        // Onboarding records
        supabase
          .from("agent_onboarding")
          .select("id, status, updated_at, completion_percentage")
          .eq("brokerage_id", brokerageId)
          .in("status", ["pending", "in_progress"]),
        // Incomplete agent setups
        supabase
          .from("agents")
          .select("id", { count: "exact", head: true })
          .eq("brokerage_id", brokerageId)
          .is("license_number", null),
        // Provider issues
        supabase
          .from("provider_overrides")
          .select("id", { count: "exact", head: true })
          .eq("scope_id", brokerageId)
          .eq("enabled", false),
        // Assignment log for pressure detection
        supabase
          .from("assignment_log")
          .select("id, routing_reason")
          .eq("brokerage_id", brokerageId)
          .gte("created_at", weekAgo.toISOString())
          .limit(100),
        // Admin backlog (pending tasks)
        supabase
          .from("tasks")
          .select("id", { count: "exact", head: true })
          .eq("brokerage_id", brokerageId)
          .eq("status", "pending"),
      ])

      // Calculate stuck onboarding (no progress in 7+ days)
      const stuckOnboarding = (onboarding || []).filter((o) => {
        if (!o.updated_at) return false
        const lastUpdate = new Date(o.updated_at)
        return lastUpdate < weekAgo && (o.completion_percentage || 0) < 100
      }).length

      // Calculate assignment pressure (high volume or exceptions)
      const assignmentPressure = (assignmentLog || []).filter(
        (a) => a.routing_reason?.includes("exception") || a.routing_reason?.includes("manual")
      ).length

      setData({
        onboardingActive: (onboarding || []).length,
        onboardingStuck: stuckOnboarding,
        incompleteSetups: incompleteSetups || 0,
        providerIssues: providerIssues || 0,
        assignmentPressure,
        adminBacklog: adminBacklog || 0,
      })
      setLoading(false)
    }

    loadOperations()
  }, [brokerageId])

  if (loading) {
    return (
      <Card className="border-border">
        <CardContent className="flex items-center justify-center p-8">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    )
  }

  if (!data) return null

  const signals = [
    {
      label: "Onboarding Active",
      value: data.onboardingActive,
      status: data.onboardingActive > 0 ? "active" : "clear",
      icon: UserPlus,
    },
    {
      label: "Stuck Onboarding",
      value: data.onboardingStuck,
      status: data.onboardingStuck > 0 ? "warning" : "clear",
      icon: AlertCircle,
    },
    {
      label: "Incomplete Setups",
      value: data.incompleteSetups,
      status: data.incompleteSetups > 3 ? "warning" : data.incompleteSetups > 0 ? "active" : "clear",
      icon: Settings,
    },
    {
      label: "Provider Issues",
      value: data.providerIssues,
      status: data.providerIssues > 0 ? "warning" : "clear",
      icon: Settings,
    },
    {
      label: "Assignment Pressure",
      value: data.assignmentPressure,
      status: data.assignmentPressure > 5 ? "warning" : data.assignmentPressure > 0 ? "active" : "clear",
      icon: GitBranch,
    },
    {
      label: "Admin Backlog",
      value: data.adminBacklog,
      status: data.adminBacklog > 10 ? "warning" : data.adminBacklog > 0 ? "active" : "clear",
      icon: ListChecks,
    },
  ]

  const totalIssues = signals.filter((s) => s.status === "warning").length
  const healthScore = Math.max(0, 100 - totalIssues * 15)

  return (
    <Card className="border-border">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base font-semibold">Operations Radar</CardTitle>
          <Badge 
            variant={healthScore >= 80 ? "outline" : healthScore >= 50 ? "secondary" : "destructive"}
            className="text-xs"
          >
            Health: {healthScore}%
          </Badge>
        </div>
        <Progress 
          value={healthScore} 
          className={`h-1.5 ${healthScore >= 80 ? "[&>div]:bg-emerald-500" : healthScore >= 50 ? "[&>div]:bg-amber-500" : "[&>div]:bg-red-500"}`}
        />
      </CardHeader>
      <CardContent className="pt-0">
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          {signals.map((signal) => {
            const Icon = signal.icon
            const statusColors = {
              clear: "bg-emerald-50 text-emerald-700 border-emerald-200",
              active: "bg-blue-50 text-blue-700 border-blue-200",
              warning: "bg-amber-50 text-amber-700 border-amber-200",
            }

            return (
              <div
                key={signal.label}
                className={`p-3 rounded-lg border ${statusColors[signal.status]}`}
              >
                <div className="flex items-center gap-2 mb-1">
                  <Icon className="h-4 w-4" />
                  <span className="text-xs font-medium">{signal.label}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xl font-bold">{signal.value}</span>
                  {signal.status === "clear" && (
                    <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}
