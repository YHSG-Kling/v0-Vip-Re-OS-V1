"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Building2, Users, AlertTriangle, CheckCircle, Clock, DollarSign } from "lucide-react"

interface PlatformHealthRadarProps {
  activeBrokerages: number
  totalUsers: number
  criticalErrors: number
  healthyServices: number
  degradedServices: number
  pendingBillingIssues: number
  aiApprovalRate: number
  lastCheckedAt: string | null
}

export function PlatformHealthRadar({
  activeBrokerages,
  totalUsers,
  criticalErrors,
  healthyServices,
  degradedServices,
  pendingBillingIssues,
  aiApprovalRate,
  lastCheckedAt,
}: PlatformHealthRadarProps) {
  const overallStatus = criticalErrors > 0 ? "critical" : degradedServices > 0 ? "degraded" : "operational"

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg">Platform Health Radar</CardTitle>
          <Badge
            variant={overallStatus === "critical" ? "destructive" : overallStatus === "degraded" ? "outline" : "default"}
            className={overallStatus === "operational" ? "bg-green-600" : ""}
          >
            {overallStatus === "critical" ? "Critical Issues" : overallStatus === "degraded" ? "Degraded" : "Operational"}
          </Badge>
        </div>
        {lastCheckedAt && (
          <p className="text-xs text-muted-foreground">Last checked: {new Date(lastCheckedAt).toLocaleString()}</p>
        )}
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="flex items-center gap-3 p-3 bg-muted/50 rounded-lg">
            <Building2 className="h-5 w-5 text-primary" />
            <div>
              <p className="text-2xl font-bold">{activeBrokerages}</p>
              <p className="text-xs text-muted-foreground">Active Brokerages</p>
            </div>
          </div>
          <div className="flex items-center gap-3 p-3 bg-muted/50 rounded-lg">
            <Users className="h-5 w-5 text-blue-500" />
            <div>
              <p className="text-2xl font-bold">{totalUsers.toLocaleString()}</p>
              <p className="text-xs text-muted-foreground">Total Users</p>
            </div>
          </div>
          <div className="flex items-center gap-3 p-3 bg-muted/50 rounded-lg">
            <CheckCircle className="h-5 w-5 text-green-500" />
            <div>
              <p className="text-2xl font-bold">{healthyServices}</p>
              <p className="text-xs text-muted-foreground">Healthy Services</p>
            </div>
          </div>
          <div className="flex items-center gap-3 p-3 bg-muted/50 rounded-lg">
            <Clock className="h-5 w-5 text-yellow-500" />
            <div>
              <p className="text-2xl font-bold">{degradedServices}</p>
              <p className="text-xs text-muted-foreground">Degraded</p>
            </div>
          </div>
          <div className="flex items-center gap-3 p-3 bg-muted/50 rounded-lg">
            <AlertTriangle className="h-5 w-5 text-red-500" />
            <div>
              <p className="text-2xl font-bold">{criticalErrors}</p>
              <p className="text-xs text-muted-foreground">Critical Errors</p>
            </div>
          </div>
          <div className="flex items-center gap-3 p-3 bg-muted/50 rounded-lg">
            <DollarSign className="h-5 w-5 text-orange-500" />
            <div>
              <p className="text-2xl font-bold">{pendingBillingIssues}</p>
              <p className="text-xs text-muted-foreground">Billing Issues</p>
            </div>
          </div>
          <div className="col-span-2 flex items-center gap-3 p-3 bg-muted/50 rounded-lg">
            <div className="flex-1">
              <div className="flex items-center justify-between mb-1">
                <p className="text-xs text-muted-foreground">AI Approval Rate</p>
                <p className="text-sm font-medium">{aiApprovalRate.toFixed(1)}%</p>
              </div>
              <div className="h-2 bg-muted rounded-full overflow-hidden">
                <div
                  className={`h-full transition-all ${aiApprovalRate >= 80 ? "bg-green-500" : aiApprovalRate >= 60 ? "bg-yellow-500" : "bg-red-500"}`}
                  style={{ width: `${Math.min(aiApprovalRate, 100)}%` }}
                />
              </div>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
