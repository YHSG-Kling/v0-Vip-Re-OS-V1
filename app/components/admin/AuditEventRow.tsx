"use client"

import { ReactNode } from "react"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { Shield } from "lucide-react"

interface AuditEvent {
  id: string
  timestamp: string
  entity_type: string
  entity_id: string | null
  event_type: string
  actor_name: string
  subject_name: string | null
  summary: string
  metadata_json: Record<string, unknown>
  source_table: string
}

interface AuditEventRowProps {
  event: AuditEvent
  icon: ReactNode
  isComplianceSensitive: boolean
  onClick: () => void
}

export function AuditEventRow({
  event,
  icon,
  isComplianceSensitive,
  onClick,
}: AuditEventRowProps) {
  const formatTimestamp = (timestamp: string) => {
    const date = new Date(timestamp)
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(date)
  }

  const getEntityBadgeVariant = (entityType: string) => {
    switch (entityType) {
      case "commission":
        return "default"
      case "document":
        return "secondary"
      case "voice_call":
      case "isa_call":
        return "outline"
      case "message":
        return "secondary"
      case "badge":
        return "default"
      default:
        return "outline"
    }
  }

  const getSourceTableLabel = (sourceTable: string) => {
    const labels: Record<string, string> = {
      lifecycle_events: "lifecycle",
      client_portal_messages: "portal",
      transaction_documents: "docs",
      commission_distributions: "commission",
      vapi_voice_calls: "vapi",
      ai_isa_calls: "isa",
      agent_badges: "badges",
      accounting_sync_log: "sync",
      portal_access_logs: "access",
    }
    return labels[sourceTable] || sourceTable
  }

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-4 rounded-lg border p-4 text-left transition-colors hover:bg-muted/50",
        isComplianceSensitive && "border-l-4 border-l-amber-500"
      )}
    >
      {/* Icon */}
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted">
        {icon}
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium">{event.summary}</span>
          {isComplianceSensitive && (
            <Shield className="h-4 w-4 shrink-0 text-amber-600" />
          )}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span>{event.actor_name}</span>
          {event.subject_name && (
            <>
              <span className="text-muted-foreground/50">|</span>
              <span>{event.subject_name}</span>
            </>
          )}
        </div>
      </div>

      {/* Badges */}
      <div className="flex shrink-0 flex-col items-end gap-1">
        <Badge variant={getEntityBadgeVariant(event.entity_type)}>
          {event.entity_type.replace(/_/g, " ")}
        </Badge>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>{formatTimestamp(event.timestamp)}</span>
          <Badge variant="outline" className="text-xs">
            {getSourceTableLabel(event.source_table)}
          </Badge>
        </div>
      </div>
    </button>
  )
}
