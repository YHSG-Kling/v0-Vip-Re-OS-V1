"use client"

import { useState } from "react"
import Link from "next/link"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import {
  User,
  Calendar,
  Database,
  ExternalLink,
  Code,
  Shield,
} from "lucide-react"

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

interface AuditEventDrawerProps {
  event: AuditEvent | null
  open: boolean
  onClose: () => void
}

export function AuditEventDrawer({ event, open, onClose }: AuditEventDrawerProps) {
  const [showRawJson, setShowRawJson] = useState(false)

  if (!event) return null

  const formatTimestamp = (timestamp: string) => {
    return new Intl.DateTimeFormat("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
    }).format(new Date(timestamp))
  }

  const getEntityLink = () => {
    if (!event.entity_id) return null

    switch (event.entity_type) {
      case "message":
      case "portal_access":
        return `/dashboard/crm/${event.entity_id}`
      case "document":
      case "commission":
        return `/dashboard/transactions/${event.entity_id}`
      case "voice_call":
      case "isa_call":
        return `/dashboard/voice/review/${event.entity_id}`
      case "badge":
        return `/dashboard/agent/${event.entity_id}`
      default:
        return null
    }
  }

  const entityLink = getEntityLink()

  const isComplianceSensitive = ["commission", "document", "voice_call", "isa_call", "portal_access"].includes(event.entity_type)

  // Format metadata for display
  const metadataEntries = Object.entries(event.metadata_json).filter(
    ([key]) => !["agent_id", "contact_id"].includes(key)
  )

  return (
    <Sheet open={open} onOpenChange={onClose}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            Event Detail
            {isComplianceSensitive && (
              <Badge variant="outline" className="border-amber-500 text-amber-600">
                <Shield className="mr-1 h-3 w-3" />
                Compliance
              </Badge>
            )}
          </SheetTitle>
          <SheetDescription>
            Full details for audit event
          </SheetDescription>
        </SheetHeader>

        <div className="mt-6 space-y-6">
          {/* Summary */}
          <div>
            <h3 className="text-lg font-semibold">{event.summary}</h3>
            <Badge className="mt-2" variant="secondary">
              {event.entity_type.replace(/_/g, " ")}
            </Badge>
          </div>

          <Separator />

          {/* Event Info */}
          <div className="grid gap-4">
            <div className="flex items-start gap-3">
              <Calendar className="mt-0.5 h-5 w-5 text-muted-foreground" />
              <div>
                <p className="text-sm font-medium">Timestamp</p>
                <p className="text-sm text-muted-foreground">
                  {formatTimestamp(event.timestamp)}
                </p>
              </div>
            </div>

            <div className="flex items-start gap-3">
              <User className="mt-0.5 h-5 w-5 text-muted-foreground" />
              <div>
                <p className="text-sm font-medium">Actor</p>
                <p className="text-sm text-muted-foreground">{event.actor_name}</p>
              </div>
            </div>

            {event.subject_name && (
              <div className="flex items-start gap-3">
                <User className="mt-0.5 h-5 w-5 text-muted-foreground" />
                <div>
                  <p className="text-sm font-medium">Subject</p>
                  <p className="text-sm text-muted-foreground">{event.subject_name}</p>
                </div>
              </div>
            )}

            <div className="flex items-start gap-3">
              <Database className="mt-0.5 h-5 w-5 text-muted-foreground" />
              <div>
                <p className="text-sm font-medium">Source Table</p>
                <Badge variant="outline">{event.source_table}</Badge>
              </div>
            </div>
          </div>

          <Separator />

          {/* Metadata */}
          <div>
            <h4 className="mb-3 font-medium">Metadata</h4>
            {metadataEntries.length > 0 ? (
              <div className="space-y-2">
                {metadataEntries.map(([key, value]) => (
                  <div
                    key={key}
                    className="flex items-start justify-between gap-4 rounded-lg bg-muted/50 p-3"
                  >
                    <span className="text-sm font-medium text-muted-foreground">
                      {key.replace(/_/g, " ")}
                    </span>
                    <span className="text-right text-sm">
                      {typeof value === "object"
                        ? JSON.stringify(value)
                        : String(value)}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No additional metadata</p>
            )}
          </div>

          <Separator />

          {/* Related Entity Link */}
          {entityLink && (
            <div>
              <h4 className="mb-3 font-medium">Related Links</h4>
              <Link href={entityLink}>
                <Button variant="outline" className="w-full justify-start">
                  <ExternalLink className="mr-2 h-4 w-4" />
                  View Related {event.entity_type.replace(/_/g, " ")}
                </Button>
              </Link>
            </div>
          )}

          <Separator />

          {/* Raw JSON Toggle (Compliance Officer) */}
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <Switch
                id="raw-json"
                checked={showRawJson}
                onCheckedChange={setShowRawJson}
              />
              <Label htmlFor="raw-json" className="flex items-center gap-2">
                <Code className="h-4 w-4" />
                Show Raw JSON
              </Label>
            </div>

            {showRawJson && (
              <pre className="max-h-64 overflow-auto rounded-lg bg-muted p-4 text-xs">
                {JSON.stringify(
                  {
                    id: event.id,
                    timestamp: event.timestamp,
                    entity_type: event.entity_type,
                    entity_id: event.entity_id,
                    event_type: event.event_type,
                    actor_name: event.actor_name,
                    subject_name: event.subject_name,
                    summary: event.summary,
                    metadata_json: event.metadata_json,
                    source_table: event.source_table,
                  },
                  null,
                  2
                )}
              </pre>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}
