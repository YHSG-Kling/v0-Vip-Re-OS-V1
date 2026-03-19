"use client"

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { CheckCircle2, AlertTriangle, XCircle, Shield } from "lucide-react"

interface ComplianceStats {
  totalAgents: number
  compliantAgents: number
  pendingReview: number
  violations: number
  licenseExpiringCount: number
}

interface BrokerageComplianceOverviewProps {
  stats?: ComplianceStats
}

export function BrokerageComplianceOverview({
  stats = {
    totalAgents: 0,
    compliantAgents: 0,
    pendingReview: 0,
    violations: 0,
    licenseExpiringCount: 0,
  },
}: BrokerageComplianceOverviewProps) {
  const complianceRate = stats.totalAgents > 0 
    ? Math.round((stats.compliantAgents / stats.totalAgents) * 100) 
    : 100

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>Compliance Overview</CardTitle>
            <CardDescription>Agent compliance status</CardDescription>
          </div>
          <Badge variant={complianceRate >= 90 ? "default" : complianceRate >= 70 ? "secondary" : "destructive"}>
            {complianceRate}% Compliant
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-2">
          <div className="flex justify-between text-sm">
            <span>Overall Compliance</span>
            <span className="font-medium">{stats.compliantAgents}/{stats.totalAgents} agents</span>
          </div>
          <Progress value={complianceRate} className="h-2" />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="flex items-center gap-3 p-3 border rounded-lg">
            <div className="p-2 rounded-full bg-emerald-500/10">
              <CheckCircle2 className="w-5 h-5 text-emerald-500" />
            </div>
            <div>
              <p className="text-2xl font-bold">{stats.compliantAgents}</p>
              <p className="text-xs text-muted-foreground">Fully Compliant</p>
            </div>
          </div>

          <div className="flex items-center gap-3 p-3 border rounded-lg">
            <div className="p-2 rounded-full bg-amber-500/10">
              <AlertTriangle className="w-5 h-5 text-amber-500" />
            </div>
            <div>
              <p className="text-2xl font-bold">{stats.pendingReview}</p>
              <p className="text-xs text-muted-foreground">Pending Review</p>
            </div>
          </div>

          <div className="flex items-center gap-3 p-3 border rounded-lg">
            <div className="p-2 rounded-full bg-red-500/10">
              <XCircle className="w-5 h-5 text-red-500" />
            </div>
            <div>
              <p className="text-2xl font-bold">{stats.violations}</p>
              <p className="text-xs text-muted-foreground">Active Violations</p>
            </div>
          </div>

          <div className="flex items-center gap-3 p-3 border rounded-lg">
            <div className="p-2 rounded-full bg-blue-500/10">
              <Shield className="w-5 h-5 text-blue-500" />
            </div>
            <div>
              <p className="text-2xl font-bold">{stats.licenseExpiringCount}</p>
              <p className="text-xs text-muted-foreground">Licenses Expiring</p>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
