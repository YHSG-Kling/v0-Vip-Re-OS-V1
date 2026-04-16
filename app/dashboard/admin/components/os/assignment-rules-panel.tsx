"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { 
  GitBranch, 
  ChevronRight,
  AlertCircle,
  CheckCircle2,
  Loader2,
  Activity
} from "lucide-react"
import Link from "next/link"
import { createClient } from "@/lib/supabase/client"

interface AssignmentRulesPanelProps {
  brokerageId: string
}

interface RuleHealth {
  totalRules: number
  activeRules: number
  triggeredThisWeek: number
  exceptionCount: number
  topRules: Array<{
    id: string
    name: string
    times_triggered: number
    is_active: boolean
  }>
}

export function AssignmentRulesPanel({ brokerageId }: AssignmentRulesPanelProps) {
  const [health, setHealth] = useState<RuleHealth | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function loadRules() {
      if (!brokerageId) {
        setLoading(false)
        return
      }

      const supabase = createClient()
      const weekAgo = new Date()
      weekAgo.setDate(weekAgo.getDate() - 7)

      const [
        { data: rules, count: totalRules },
        { data: recentAssignments },
      ] = await Promise.all([
        supabase
          .from("assignment_rules")
          .select("id, name, is_active, times_triggered", { count: "exact" })
          .eq("brokerage_id", brokerageId)
          .order("times_triggered", { ascending: false })
          .limit(5),
        supabase
          .from("assignment_log")
          .select("routing_reason")
          .eq("brokerage_id", brokerageId)
          .gte("created_at", weekAgo.toISOString()),
      ])

      const activeRules = (rules || []).filter((r: any) => r.is_active).length
      const exceptionCount = (recentAssignments || []).filter(
        (a: any) => a.routing_reason?.includes("exception") || a.routing_reason?.includes("manual")
      ).length

      setHealth({
        totalRules: totalRules || 0,
        activeRules,
        triggeredThisWeek: (recentAssignments || []).length,
        exceptionCount,
        topRules: (rules || []).slice(0, 3),
      })
      setLoading(false)
    }

    loadRules()
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

  if (!health) return null

  const healthStatus = health.exceptionCount > 5 ? "warning" : health.activeRules > 0 ? "healthy" : "inactive"

  return (
    <Card className="border-border">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base font-semibold">
            <GitBranch className="h-4 w-4 text-indigo-600" />
            Assignment Rules
          </CardTitle>
          <Badge 
            variant={healthStatus === "healthy" ? "outline" : healthStatus === "warning" ? "secondary" : "destructive"}
            className="text-xs"
          >
            {healthStatus === "healthy" ? "Healthy" : healthStatus === "warning" ? "Exceptions" : "Inactive"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="pt-0 space-y-4">
        {/* Stats Grid */}
        <div className="grid grid-cols-3 gap-2">
          <div className="text-center p-2 bg-muted/50 rounded-lg">
            <p className="text-lg font-bold">{health.activeRules}</p>
            <p className="text-xs text-muted-foreground">Active</p>
          </div>
          <div className="text-center p-2 bg-muted/50 rounded-lg">
            <p className="text-lg font-bold">{health.triggeredThisWeek}</p>
            <p className="text-xs text-muted-foreground">This Week</p>
          </div>
          <div className={`text-center p-2 rounded-lg ${health.exceptionCount > 0 ? "bg-amber-50" : "bg-muted/50"}`}>
            <p className={`text-lg font-bold ${health.exceptionCount > 0 ? "text-amber-700" : ""}`}>
              {health.exceptionCount}
            </p>
            <p className="text-xs text-muted-foreground">Exceptions</p>
          </div>
        </div>

        {/* Top Rules */}
        {health.topRules.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">Top Rules</p>
            {health.topRules.map((rule) => (
              <div
                key={rule.id}
                className="flex items-center justify-between p-2 bg-muted/30 rounded-lg"
              >
                <div className="flex items-center gap-2">
                  {rule.is_active ? (
                    <CheckCircle2 className="h-3 w-3 text-emerald-500" />
                  ) : (
                    <AlertCircle className="h-3 w-3 text-muted-foreground" />
                  )}
                  <span className="text-sm truncate max-w-[150px]">{rule.name}</span>
                </div>
                <Badge variant="outline" className="text-xs">
                  {rule.times_triggered}x
                </Badge>
              </div>
            ))}
          </div>
        )}

        <Link href="/dashboard/admin/assignment-rules">
          <Button variant="outline" size="sm" className="w-full">
            Manage Rules
            <ChevronRight className="h-4 w-4 ml-1" />
          </Button>
        </Link>
      </CardContent>
    </Card>
  )
}
