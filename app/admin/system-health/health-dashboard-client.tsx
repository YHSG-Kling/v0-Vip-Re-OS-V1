"use client"

import { useState, useEffect, useCallback } from "react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { RefreshCw, CheckCircle, AlertTriangle, XCircle } from "lucide-react"
import { triggerManualHealthCheck, type ServiceStatus } from "@/app/actions/system-health"
import { useToast } from "@/hooks/use-toast"

interface HealthDashboardClientProps {
  initialServices: ServiceStatus[]
  initialOverallStatus: "operational" | "critical" | "degraded"
  initialCriticalIssues: ServiceStatus[]
  initialLastCheckedAt: string | null
}

export function HealthDashboardClient({
  initialServices,
  initialOverallStatus,
  initialCriticalIssues,
  initialLastCheckedAt,
}: HealthDashboardClientProps) {
  const [services, setServices] = useState(initialServices)
  const [overallStatus, setOverallStatus] = useState(initialOverallStatus)
  const [criticalIssues, setCriticalIssues] = useState(initialCriticalIssues)
  const [lastCheckedAt, setLastCheckedAt] = useState(initialLastCheckedAt)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [previousCriticalKeys, setPreviousCriticalKeys] = useState<Set<string>>(
    new Set(initialCriticalIssues.map((s) => s.service_key))
  )
  const { toast } = useToast()

  // Poll for updates every 30 seconds
  const fetchStatus = useCallback(async () => {
    try {
      const response = await fetch("/api/admin/health-status")
      if (!response.ok) return

      const data = await response.json()
      setServices(data.services)
      setOverallStatus(data.overallStatus)
      setCriticalIssues(data.criticalIssues)
      setLastCheckedAt(data.lastCheckedAt)

      // Check for new critical issues
      const newCriticalKeys = new Set(
        data.criticalIssues.map((s: ServiceStatus) => s.service_key)
      )
      const newDownServices = data.criticalIssues.filter(
        (s: ServiceStatus) => !previousCriticalKeys.has(s.service_key)
      )

      if (newDownServices.length > 0) {
        toast({
          title: "Critical Service Alert",
          description: `${newDownServices[0].service_name} is now down`,
          variant: "destructive",
        })
      }

      setPreviousCriticalKeys(new Set(Array.from(newCriticalKeys).filter((v): v is string => typeof v === 'string')))
    } catch (error) {
      console.error("Error polling health status:", error)
    }
  }, [previousCriticalKeys, toast])

  useEffect(() => {
    const interval = setInterval(fetchStatus, 30000)
    return () => clearInterval(interval)
  }, [fetchStatus])

  const handleRefresh = async () => {
    setIsRefreshing(true)
    try {
      const result = await triggerManualHealthCheck()
      if (result.success) {
        toast({
          title: "Health check triggered",
          description: "Refreshing status...",
        })
        // Wait a moment then fetch updated status
        setTimeout(fetchStatus, 2000)
      } else {
        toast({
          title: "Failed to trigger health check",
          description: result.message,
          variant: "destructive",
        })
      }
    } catch {
      toast({
        title: "Error",
        description: "Failed to trigger health check",
        variant: "destructive",
      })
    } finally {
      setIsRefreshing(false)
    }
  }

  const getStatusBadge = () => {
    switch (overallStatus) {
      case "operational":
        return (
          <Badge className="bg-green-500/10 text-green-600 gap-1">
            <CheckCircle className="h-3 w-3" />
            All Systems Operational
          </Badge>
        )
      case "degraded":
        return (
          <Badge variant="secondary" className="gap-1">
            <AlertTriangle className="h-3 w-3" />
            Degraded Performance
          </Badge>
        )
      case "critical":
        return (
          <Badge variant="destructive" className="gap-1 animate-pulse">
            <XCircle className="h-3 w-3" />
            Critical Service Down
          </Badge>
        )
    }
  }

  const formatLastChecked = () => {
    if (!lastCheckedAt) return "Never"
    const date = new Date(lastCheckedAt)
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffSeconds = Math.floor(diffMs / 1000)
    const diffMinutes = Math.floor(diffSeconds / 60)

    if (diffSeconds < 60) {
      return `${diffSeconds} seconds ago`
    } else if (diffMinutes < 60) {
      return `${diffMinutes} minute${diffMinutes > 1 ? "s" : ""} ago`
    } else {
      return date.toLocaleTimeString()
    }
  }

  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <h1 className="text-2xl font-bold">System Health Monitor</h1>
        <p className="text-sm text-muted-foreground">
          Last updated: {formatLastChecked()}
        </p>
      </div>
      <div className="flex items-center gap-3">
        <Button
          variant="outline"
          size="sm"
          onClick={handleRefresh}
          disabled={isRefreshing}
        >
          <RefreshCw
            className={`h-4 w-4 mr-2 ${isRefreshing ? "animate-spin" : ""}`}
          />
          Refresh Now
        </Button>
        {getStatusBadge()}
      </div>
    </div>
  )
}
