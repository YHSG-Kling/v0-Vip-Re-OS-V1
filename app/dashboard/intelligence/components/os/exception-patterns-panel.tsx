"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import Link from "next/link"
import {
  AlertTriangle,
  ArrowRight,
  Clock,
  XCircle,
  CheckCircle2,
  Eye,
} from "lucide-react"
import { dismissPattern } from "@/app/actions/pattern-actions"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

interface ExceptionPattern {
  id: string
  type: "sla_breach" | "compliance_risk" | "performance_drop" | "system_anomaly"
  title: string
  description: string
  severity: "critical" | "warning" | "info"
  detectedAt: string
  affectedEntity: string
  affectedEntityId: string
  entityType: string
  status: "active" | "acknowledged" | "resolved"
}

interface ExceptionPatternsPanelProps {
  exceptions: ExceptionPattern[]
  onResolve?: (exceptionId: string) => void
}

export function ExceptionPatternsPanel({
  exceptions,
  onResolve,
}: ExceptionPatternsPanelProps) {
  const router = useRouter()
  const activeExceptions = exceptions.filter(e => e.status === "active")
  const criticalCount = activeExceptions.filter(e => e.severity === "critical").length

  const handleDismiss = async (exceptionId: string) => {
    try {
      await dismissPattern(exceptionId)
      toast.success("Exception dismissed")
      router.refresh()
    } catch (error) {
      toast.error("Failed to dismiss exception")
    }
  }

  const getSeverityColor = (severity: string) => {
    switch (severity) {
      case "critical": return "bg-red-100 text-red-700 border-red-300 dark:bg-red-900/30 dark:text-red-400 dark:border-red-700"
      case "warning": return "bg-amber-100 text-amber-700 border-amber-300 dark:bg-amber-900/30 dark:text-amber-400 dark:border-amber-700"
      case "info": return "bg-blue-100 text-blue-700 border-blue-300 dark:bg-blue-900/30 dark:text-blue-400 dark:border-blue-700"
      default: return "bg-muted text-muted-foreground border-border"
    }
  }

  const getTypeIcon = (type: string) => {
    switch (type) {
      case "sla_breach": return <Clock className="h-4 w-4 text-red-600" />
      case "compliance_risk": return <AlertTriangle className="h-4 w-4 text-amber-600" />
      case "performance_drop": return <XCircle className="h-4 w-4 text-red-600" />
      case "system_anomaly": return <AlertTriangle className="h-4 w-4 text-purple-600" />
      default: return <AlertTriangle className="h-4 w-4" />
    }
  }

  const getEntityLink = (entityType: string, entityId: string) => {
    switch (entityType) {
      case "agent": return `/dashboard/team/${entityId}`
      case "transaction": return `/dashboard/transactions/${entityId}`
      case "listing": return `/dashboard/listings/${entityId}`
      default: return "#"
    }
  }

  const formatTimeAgo = (dateStr: string) => {
    const date = new Date(dateStr)
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffMins = Math.floor(diffMs / 60000)
    const diffHours = Math.floor(diffMins / 60)
    const diffDays = Math.floor(diffHours / 24)

    if (diffDays > 0) return `${diffDays}d ago`
    if (diffHours > 0) return `${diffHours}h ago`
    return `${diffMins}m ago`
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <AlertTriangle className="h-4 w-4 text-primary" />
            Exception Patterns
          </CardTitle>
          {criticalCount > 0 ? (
            <Badge variant="destructive" className="text-xs">
              {criticalCount} critical
            </Badge>
          ) : activeExceptions.length > 0 ? (
            <Badge variant="secondary" className="text-xs">
              {activeExceptions.length} active
            </Badge>
          ) : (
            <Badge variant="outline" className="text-xs text-green-600">
              All clear
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {activeExceptions.length === 0 ? (
          <div className="py-4 text-center text-sm text-muted-foreground">
            <CheckCircle2 className="mx-auto mb-2 h-8 w-8 text-green-500" />
            No exceptions detected
          </div>
        ) : (
          activeExceptions.slice(0, 3).map((exception) => (
            <div
              key={exception.id}
              className={`rounded-lg border p-3 space-y-2 ${getSeverityColor(exception.severity)}`}
            >
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-2">
                  {getTypeIcon(exception.type)}
                  <span className="font-medium text-sm">{exception.title}</span>
                </div>
                <span className="text-xs text-muted-foreground">
                  {formatTimeAgo(exception.detectedAt)}
                </span>
              </div>

              <p className="text-xs opacity-80">
                {exception.description}
              </p>

              <div className="flex items-center justify-between">
                <Link 
                  href={getEntityLink(exception.entityType, exception.affectedEntityId)}
                  className="text-xs hover:underline"
                >
                  {exception.affectedEntity}
                </Link>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 text-xs"
                    onClick={() => handleDismiss(exception.id)}
                  >
                    Dismiss
                  </Button>
                  <Link href={getEntityLink(exception.entityType, exception.affectedEntityId)}>
                    <Button variant="ghost" size="sm" className="h-6 text-xs">
                      <Eye className="h-3 w-3 mr-1" />
                      View
                    </Button>
                  </Link>
                </div>
              </div>
            </div>
          ))
        )}

        {activeExceptions.length > 3 && (
          <p className="text-center text-xs text-muted-foreground">
            +{activeExceptions.length - 3} more exceptions
          </p>
        )}

        <Link href="/dashboard/patterns?filter=exceptions">
          <Button variant="outline" size="sm" className="w-full gap-2">
            View All Exceptions
            <ArrowRight className="h-4 w-4" />
          </Button>
        </Link>
      </CardContent>
    </Card>
  )
}
