"use client"

import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { AlertTriangle, Shield, FileWarning, ChevronRight } from "lucide-react"
import Link from "next/link"

interface ComplianceCommandStripProps {
  pendingApprovalsCount: number
  criticalViolations: number
  complianceRate: number
  blockingIssues: number
}

export function ComplianceCommandStrip({
  pendingApprovalsCount,
  criticalViolations,
  complianceRate,
  blockingIssues,
}: ComplianceCommandStripProps) {
  // Determine highest priority issue
  const getPriorityAction = () => {
    if (criticalViolations > 0) {
      return {
        urgency: "critical" as const,
        title: `${criticalViolations} Critical Violation${criticalViolations > 1 ? "s" : ""} Require Immediate Action`,
        reason: "Critical compliance violations can result in regulatory penalties and legal liability.",
        action: "Review Violations",
        href: "#violations",
        icon: AlertTriangle,
      }
    }
    if (blockingIssues > 0) {
      return {
        urgency: "high" as const,
        title: `${blockingIssues} Blocking Issue${blockingIssues > 1 ? "s" : ""} Preventing Deal Progress`,
        reason: "These compliance checks must pass before transactions can proceed to closing prep.",
        action: "Resolve Issues",
        href: "#transactions",
        icon: FileWarning,
      }
    }
    if (pendingApprovalsCount > 0) {
      return {
        urgency: "medium" as const,
        title: `${pendingApprovalsCount} Content Item${pendingApprovalsCount > 1 ? "s" : ""} Awaiting Approval`,
        reason: "Marketing content requires compliance review before distribution.",
        action: "Review Content",
        href: "#pending",
        icon: Shield,
      }
    }
    return {
      urgency: "low" as const,
      title: "All Compliance Checks Passing",
      reason: `Brokerage compliance rate is ${complianceRate}%. No immediate action required.`,
      action: "View Report",
      href: "#violations",
      icon: Shield,
    }
  }

  const priority = getPriorityAction()

  const urgencyStyles = {
    critical: "border-destructive/50 bg-destructive/5",
    high: "border-orange-500/50 bg-orange-500/5",
    medium: "border-yellow-500/50 bg-yellow-500/5",
    low: "border-green-500/50 bg-green-500/5",
  }

  const urgencyBadgeStyles = {
    critical: "bg-destructive text-destructive-foreground",
    high: "bg-orange-500 text-white",
    medium: "bg-yellow-500 text-yellow-950",
    low: "bg-green-500 text-white",
  }

  const Icon = priority.icon

  return (
    <Card className={`border-2 ${urgencyStyles[priority.urgency]}`}>
      <CardContent className="p-4">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className={`rounded-full p-3 ${priority.urgency === "critical" ? "bg-destructive/10" : priority.urgency === "high" ? "bg-orange-500/10" : priority.urgency === "medium" ? "bg-yellow-500/10" : "bg-green-500/10"}`}>
              <Icon className={`h-6 w-6 ${priority.urgency === "critical" ? "text-destructive" : priority.urgency === "high" ? "text-orange-500" : priority.urgency === "medium" ? "text-yellow-600" : "text-green-500"}`} />
            </div>
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <Badge className={urgencyBadgeStyles[priority.urgency]}>
                  {priority.urgency === "critical" ? "Critical" : priority.urgency === "high" ? "High Priority" : priority.urgency === "medium" ? "Needs Attention" : "All Clear"}
                </Badge>
                <span className="font-semibold text-foreground">{priority.title}</span>
              </div>
              <p className="text-sm text-muted-foreground">{priority.reason}</p>
            </div>
          </div>
          <Button asChild variant={priority.urgency === "critical" ? "destructive" : priority.urgency === "high" ? "default" : "outline"}>
            <Link href={priority.href}>
              {priority.action}
              <ChevronRight className="ml-1 h-4 w-4" />
            </Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
