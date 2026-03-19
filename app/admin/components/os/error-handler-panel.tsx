"use client"

import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { AlertTriangle, Clock, CheckCircle, ExternalLink } from "lucide-react"

interface AutomationError {
  id: string
  workflowName: string
  errorMessage: string
  severity: "critical" | "high" | "medium" | "low"
  status: "open" | "investigating" | "resolved"
  createdAt: string
  brokerageName?: string
}

interface ErrorHandlerPanelProps {
  errors: AutomationError[]
  criticalCount: number
  openCount: number
  resolvedToday: number
}

export function ErrorHandlerPanel({ errors, criticalCount, openCount, resolvedToday }: ErrorHandlerPanelProps) {
  const getSeverityColor = (severity: string) => {
    switch (severity) {
      case "critical":
        return "bg-red-500"
      case "high":
        return "bg-orange-500"
      case "medium":
        return "bg-yellow-500"
      default:
        return "bg-gray-500"
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg flex items-center gap-2">
            <AlertTriangle className="h-5 w-5" />
            Error Handler
          </CardTitle>
          <Link href="/admin/error-handler">
            <Button variant="ghost" size="sm" className="gap-1">
              <ExternalLink className="h-3 w-3" />
              View All
            </Button>
          </Link>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Summary */}
        <div className="grid grid-cols-3 gap-2">
          <div className="p-2 bg-red-500/10 rounded-lg text-center">
            <p className="text-lg font-bold text-red-600">{criticalCount}</p>
            <p className="text-xs text-muted-foreground">Critical</p>
          </div>
          <div className="p-2 bg-yellow-500/10 rounded-lg text-center">
            <p className="text-lg font-bold text-yellow-600">{openCount}</p>
            <p className="text-xs text-muted-foreground">Open</p>
          </div>
          <div className="p-2 bg-green-500/10 rounded-lg text-center">
            <p className="text-lg font-bold text-green-600">{resolvedToday}</p>
            <p className="text-xs text-muted-foreground">Resolved Today</p>
          </div>
        </div>

        {/* Recent Errors */}
        <div className="space-y-2">
          {errors.length === 0 ? (
            <div className="flex items-center justify-center p-4 text-muted-foreground">
              <CheckCircle className="h-5 w-5 mr-2 text-green-500" />
              <span>No open errors</span>
            </div>
          ) : (
            errors.slice(0, 4).map((error) => (
              <div
                key={error.id}
                className="flex items-start gap-3 p-2 bg-muted/50 rounded-lg hover:bg-muted/70 transition-colors"
              >
                <div className={`h-2 w-2 rounded-full mt-2 ${getSeverityColor(error.severity)}`} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium truncate">{error.workflowName}</p>
                    <Badge
                      variant="outline"
                      className={`text-xs ${error.status === "investigating" ? "bg-blue-500/10" : ""}`}
                    >
                      {error.status}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground truncate">{error.errorMessage}</p>
                  <div className="flex items-center gap-2 mt-1">
                    <Clock className="h-3 w-3 text-muted-foreground" />
                    <span className="text-xs text-muted-foreground">
                      {new Date(error.createdAt).toLocaleString()}
                    </span>
                    {error.brokerageName && (
                      <Badge variant="outline" className="text-xs">
                        {error.brokerageName}
                      </Badge>
                    )}
                  </div>
                </div>
                <Link href={`/admin/error-handler/${error.id}`}>
                  <Button variant="ghost" size="sm" className="text-xs">
                    Review
                  </Button>
                </Link>
              </div>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  )
}
