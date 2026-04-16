"use client"

import { Badge } from "@/components/ui/badge"
import { AlertTriangle, AlertCircle, AlertOctagon } from "lucide-react"

interface ErrorGroupRowProps {
  group: {
    id: string
    error_type: string
    error_count: number
    severity: "critical" | "high" | "medium" | "low"
    status: "active" | "resolved" | "dismissed"
    last_error_at: string
    error_groups?: { id: string }[]
  }
  isSelected?: boolean
}

function toRelativeTime(date: Date): string {
  const diff = Date.now() - date.getTime()
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

export function ErrorGroupRow({ group, isSelected }: ErrorGroupRowProps) {
  const getSeverityIcon = () => {
    switch (group.severity) {
      case "critical":
        return <AlertOctagon className="h-4 w-4 text-destructive" />
      case "high":
        return <AlertTriangle className="h-4 w-4 text-orange-500" />
      case "medium":
        return <AlertCircle className="h-4 w-4 text-yellow-500" />
      default:
        return <AlertCircle className="h-4 w-4 text-blue-500" />
    }
  }

  const getSeverityColor = () => {
    switch (group.severity) {
      case "critical":
        return "destructive"
      case "high":
        return "secondary"
      default:
        return "outline"
    }
  }

  const getStatusColor = () => {
    switch (group.status) {
      case "resolved":
        return "bg-green-50 text-green-700"
      case "dismissed":
        return "bg-gray-50 text-gray-700"
      default:
        return "bg-red-50 text-red-700"
    }
  }

  return (
    <div className="flex items-start gap-3">
      <div className="mt-1">{getSeverityIcon()}</div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <p className="font-medium text-sm truncate">{group.error_type}</p>
          <Badge variant={getSeverityColor()} className="text-xs">
            {group.severity}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          {group.error_count} error{group.error_count !== 1 ? "s" : ""} •{" "}
          {toRelativeTime(new Date(group.last_error_at))}
        </p>
      </div>
      <Badge className={`${getStatusColor()} text-xs whitespace-nowrap`}>
        {group.status}
      </Badge>
    </div>
  )
}
