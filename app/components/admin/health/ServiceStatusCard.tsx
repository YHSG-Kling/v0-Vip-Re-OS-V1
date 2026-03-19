"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ChevronDown, ChevronUp, AlertCircle } from "lucide-react"
import { type ServiceStatus, getServiceHealthHistory, getUptimeHistory } from "@/app/actions/system-health"
import { UptimeSparkline } from "./UptimeSparkline"

interface ServiceStatusCardProps {
  service: ServiceStatus
}

const categoryColors: Record<string, string> = {
  database: "bg-blue-500/10 text-blue-600",
  ai: "bg-purple-500/10 text-purple-600",
  email: "bg-teal-500/10 text-teal-600",
  sms: "bg-green-500/10 text-green-600",
  payment: "bg-amber-500/10 text-amber-600",
  scraper: "bg-slate-500/10 text-slate-600",
  video: "bg-pink-500/10 text-pink-600",
  accounting: "bg-orange-500/10 text-orange-600",
  voice: "bg-cyan-500/10 text-cyan-600",
  esign: "bg-indigo-500/10 text-indigo-600",
}

export function ServiceStatusCard({ service }: ServiceStatusCardProps) {
  const [isExpanded, setIsExpanded] = useState(false)
  const [history, setHistory] = useState<Awaited<ReturnType<typeof getServiceHealthHistory>>>([])
  const [uptimeData, setUptimeData] = useState<Awaited<ReturnType<typeof getUptimeHistory>>>([])
  const [isLoading, setIsLoading] = useState(false)

  const handleExpand = async () => {
    if (!isExpanded && history.length === 0) {
      setIsLoading(true)
      try {
        const [healthHistory, uptime] = await Promise.all([
          getServiceHealthHistory(service.service_key, 10),
          getUptimeHistory(service.service_key, 7),
        ])
        setHistory(healthHistory)
        setUptimeData(uptime)
      } catch (err) {
        console.error("Error fetching history:", err)
      } finally {
        setIsLoading(false)
      }
    }
    setIsExpanded(!isExpanded)
  }

  const getStatusIndicator = () => {
    switch (service.current_status) {
      case "healthy":
        return (
          <span className="flex items-center gap-1.5 text-green-600">
            <span className="h-2 w-2 rounded-full bg-green-500" />
            Healthy
          </span>
        )
      case "degraded":
        return (
          <span className="flex items-center gap-1.5 text-amber-600">
            <span className="h-2 w-2 rounded-full bg-amber-500" />
            Degraded
          </span>
        )
      case "down":
        return (
          <span className="flex items-center gap-1.5 text-destructive">
            <span className="h-2 w-2 rounded-full bg-destructive animate-pulse" />
            Down
          </span>
        )
      default:
        return (
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <span className="h-2 w-2 rounded-full bg-muted-foreground" />
            Unknown
          </span>
        )
    }
  }

  const getResponseTimeColor = () => {
    if (!service.response_time_ms) return "text-muted-foreground"
    if (service.response_time_ms < 300) return "text-green-600"
    if (service.response_time_ms < 1000) return "text-amber-600"
    return "text-destructive"
  }

  const formatLastChecked = () => {
    if (!service.last_checked_at) return "Never"
    const date = new Date(service.last_checked_at)
    const now = new Date()
    const diffSeconds = Math.floor((now.getTime() - date.getTime()) / 1000)
    if (diffSeconds < 60) return `${diffSeconds}s ago`
    if (diffSeconds < 3600) return `${Math.floor(diffSeconds / 60)}m ago`
    return date.toLocaleTimeString()
  }

  return (
    <Card className={service.current_status === "down" && service.is_critical ? "border-destructive" : ""}>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between">
          <div className="space-y-1">
            <CardTitle className="text-base flex items-center gap-2">
              {service.service_name}
              {service.is_critical && (
                <Badge variant="destructive" className="text-xs">
                  CRITICAL
                </Badge>
              )}
            </CardTitle>
            <Badge className={categoryColors[service.service_category] || "bg-slate-500/10 text-slate-600"}>
              {service.service_category}
            </Badge>
          </div>
          {getStatusIndicator()}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">Response Time</span>
          <span className={getResponseTimeColor()}>
            {service.response_time_ms ? `${service.response_time_ms}ms` : "N/A"}
          </span>
        </div>
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">Last Checked</span>
          <span>{formatLastChecked()}</span>
        </div>
        {service.consecutive_failures > 0 && (
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Consecutive Failures</span>
            <Badge variant={service.consecutive_failures > 2 ? "destructive" : "secondary"}>
              {service.consecutive_failures}
            </Badge>
          </div>
        )}

        <Button
          variant="ghost"
          size="sm"
          className="w-full"
          onClick={handleExpand}
          disabled={isLoading}
        >
          {isLoading ? (
            "Loading..."
          ) : isExpanded ? (
            <>
              <ChevronUp className="h-4 w-4 mr-1" />
              Hide History
            </>
          ) : (
            <>
              <ChevronDown className="h-4 w-4 mr-1" />
              View History
            </>
          )}
        </Button>

        {isExpanded && (
          <div className="space-y-4 pt-2 border-t">
            {/* Uptime Sparkline */}
            {uptimeData.length > 0 && (
              <div>
                <p className="text-xs text-muted-foreground mb-2">7-Day Uptime</p>
                <UptimeSparkline data={uptimeData} />
              </div>
            )}

            {/* Recent Checks */}
            <div>
              <p className="text-xs text-muted-foreground mb-2">Recent Checks</p>
              <div className="space-y-2 max-h-48 overflow-y-auto">
                {history.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No history available</p>
                ) : (
                  history.map((check) => (
                    <div
                      key={check.id}
                      className="flex items-center justify-between text-xs py-1 border-b last:border-0"
                    >
                      <div className="flex items-center gap-2">
                        <span
                          className={`h-1.5 w-1.5 rounded-full ${
                            check.status === "healthy"
                              ? "bg-green-500"
                              : check.status === "degraded"
                                ? "bg-amber-500"
                                : check.status === "down"
                                  ? "bg-destructive"
                                  : "bg-muted"
                          }`}
                        />
                        <span className="capitalize">{check.status}</span>
                      </div>
                      <div className="flex items-center gap-3 text-muted-foreground">
                        <span>{check.response_time_ms ? `${check.response_time_ms}ms` : "-"}</span>
                        <span>{new Date(check.checked_at).toLocaleTimeString()}</span>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Error Message */}
            {service.error_message && (
              <div className="flex items-start gap-2 p-2 rounded bg-destructive/10 text-destructive text-xs">
                <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                <span className="line-clamp-3">{service.error_message}</span>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
