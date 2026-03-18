"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { AlertTriangle, FileX, FileCheck, Clock, Shield } from "lucide-react"

interface ComplianceRiskRadarProps {
  flaggedFiles: number
  openExceptions: number
  missingDisclosures: number
  criticalPressure: number
  reviewBacklog: number
  complianceRate: number
}

export function ComplianceRiskRadar({
  flaggedFiles,
  openExceptions,
  missingDisclosures,
  criticalPressure,
  reviewBacklog,
  complianceRate,
}: ComplianceRiskRadarProps) {
  const riskSignals = [
    {
      label: "Flagged Files",
      value: flaggedFiles,
      icon: FileX,
      severity: flaggedFiles > 5 ? "critical" : flaggedFiles > 2 ? "warning" : "healthy",
    },
    {
      label: "Open Exceptions",
      value: openExceptions,
      icon: AlertTriangle,
      severity: openExceptions > 3 ? "critical" : openExceptions > 1 ? "warning" : "healthy",
    },
    {
      label: "Missing Disclosures",
      value: missingDisclosures,
      icon: FileCheck,
      severity: missingDisclosures > 0 ? "critical" : "healthy",
    },
    {
      label: "Review Backlog",
      value: reviewBacklog,
      icon: Clock,
      severity: reviewBacklog > 10 ? "critical" : reviewBacklog > 5 ? "warning" : "healthy",
    },
  ]

  const severityStyles = {
    critical: "text-destructive bg-destructive/10",
    warning: "text-orange-600 bg-orange-500/10",
    healthy: "text-green-600 bg-green-500/10",
  }

  const severityBadge = {
    critical: "bg-destructive text-destructive-foreground",
    warning: "bg-orange-500 text-white",
    healthy: "bg-green-500 text-white",
  }

  const overallRisk = criticalPressure > 50 ? "critical" : criticalPressure > 25 ? "warning" : "healthy"

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <Shield className="h-5 w-5 text-muted-foreground" />
            Compliance Risk Radar
          </CardTitle>
          <Badge className={severityBadge[overallRisk]}>
            {overallRisk === "critical" ? "High Risk" : overallRisk === "warning" ? "Elevated" : "Stable"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Risk Pressure Meter */}
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Critical Pressure</span>
            <span className="font-medium">{criticalPressure}%</span>
          </div>
          <Progress 
            value={criticalPressure} 
            className={`h-2 ${criticalPressure > 50 ? "[&>div]:bg-destructive" : criticalPressure > 25 ? "[&>div]:bg-orange-500" : "[&>div]:bg-green-500"}`}
          />
        </div>

        {/* Compliance Rate */}
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Compliance Rate</span>
            <span className={`font-medium ${complianceRate >= 90 ? "text-green-600" : complianceRate >= 70 ? "text-orange-600" : "text-destructive"}`}>
              {complianceRate}%
            </span>
          </div>
          <Progress 
            value={complianceRate} 
            className={`h-2 ${complianceRate >= 90 ? "[&>div]:bg-green-500" : complianceRate >= 70 ? "[&>div]:bg-orange-500" : "[&>div]:bg-destructive"}`}
          />
        </div>

        {/* Risk Signals Grid */}
        <div className="grid grid-cols-2 gap-3 pt-2">
          {riskSignals.map((signal) => {
            const Icon = signal.icon
            return (
              <div
                key={signal.label}
                className={`flex items-center gap-3 rounded-lg p-3 ${severityStyles[signal.severity]}`}
              >
                <Icon className="h-5 w-5" />
                <div>
                  <div className="text-lg font-bold">{signal.value}</div>
                  <div className="text-xs opacity-80">{signal.label}</div>
                </div>
              </div>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}
