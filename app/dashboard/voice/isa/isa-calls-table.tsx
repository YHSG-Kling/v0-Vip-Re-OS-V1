"use client"

import { useState } from "react"
import Link from "next/link"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Phone, RotateCcw, ExternalLink, User } from "lucide-react"
import { ContactHistorySheet } from "./contact-history-sheet"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
// Lane E2 2026-08-28: retryFailedCalls WIRED. The previous "retry" here was a
// 1-second setTimeout with a comment admitting it did nothing ("For now, just
// show the action was attempted"). The real action sweeps THIS agent's
// no-answer/busy/failed calls older than 4h and re-dials them through the
// TCPA-gated Twilio lane (identity from the session inside the action).
import { retryFailedCalls } from "@/app/actions/ai-isa"

interface ISACall {
  id: string
  voice_call_id: string | null
  appointment_set: boolean
  appointment_datetime: string | null
  lead_quality_score: number | null
  ai_response_summary: string | null
  created_at: string
  contact_id: string | null
  contacts: {
    id: string
    first_name: string | null
    last_name: string | null
    phone: string | null
    buyer_stage: string | null
  } | null
  call_status?: string
  call_outcome?: string
  duration_seconds?: number
}

interface ISACallsTableProps {
  calls: ISACall[]
  emptyMessage: string
  showRetry: boolean
  brokerageId?: string
}

function getOutcomeBadge(call: ISACall) {
  if (call.appointment_set) {
    return <Badge className="bg-green-500/10 text-green-600 border-green-200">Qualified</Badge>
  }
  if (call.call_status === "no_answer" || call.call_outcome === "no_answer") {
    return <Badge variant="destructive">No Answer</Badge>
  }
  if (call.call_status === "failed" || call.call_outcome === "failed") {
    return <Badge variant="destructive">Failed</Badge>
  }
  if (call.call_status === "busy") {
    return <Badge className="bg-amber-500/10 text-amber-600 border-amber-200">Busy</Badge>
  }
  if (call.call_outcome === "callback" || call.call_outcome === "voicemail") {
    return <Badge className="bg-amber-500/10 text-amber-600 border-amber-200">Callback</Badge>
  }
  if (call.voice_call_id) {
    return <Badge variant="secondary">Completed</Badge>
  }
  return <Badge variant="outline">Pending</Badge>
}

function formatDuration(seconds?: number | null): string {
  if (!seconds) return "--:--"
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  return `${mins}:${String(secs).padStart(2, '0')}`
}

function formatTime(dateString: string): string {
  return new Date(dateString).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  })
}

export function ISACallsTable({ calls, emptyMessage, showRetry }: ISACallsTableProps) {
  const router = useRouter()
  const [retrying, setRetrying] = useState(false)
  const [selectedContactId, setSelectedContactId] = useState<string | null>(null)

  // One sweep, not per-row: retryFailedCalls re-queues every eligible failed
  // call for the signed-in agent (outcome no_answer/busy/failed/canceled, at
  // least 4h old). Per-row checkboxes were removed with the fake retry — they
  // selected calls the sweep does not consult, which would be a lying UI.
  const handleRetryFailed = async () => {
    setRetrying(true)
    const res = await retryFailedCalls()
    setRetrying(false)
    if ((res as any).success) {
      const n = (res as any).retried_count ?? 0
      toast.success(n > 0 ? `Re-queued ${n} failed call${n === 1 ? "" : "s"}` : "No eligible failed calls to retry (4h cool-down)")
      router.refresh()
    } else {
      toast.error((res as any).error ?? "Retry failed")
    }
  }

  if (calls.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <Phone className="h-12 w-12 text-muted-foreground/50 mb-4" />
        <p className="text-muted-foreground">{emptyMessage}</p>
      </div>
    )
  }

  return (
    <>
      {showRetry && (
        <div className="mb-4 flex items-center gap-2">
          <Button
            size="sm"
            onClick={handleRetryFailed}
            disabled={retrying}
          >
            <RotateCcw className={`h-4 w-4 mr-2 ${retrying ? "animate-spin" : ""}`} />
            {retrying ? "Re-dialing..." : "Retry Failed Calls"}
          </Button>
          <span className="text-xs text-muted-foreground">
            Re-dials your no-answer / busy / failed calls older than 4 hours
          </span>
        </div>
      )}

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Contact</TableHead>
            <TableHead>Phone</TableHead>
            <TableHead>Outcome</TableHead>
            <TableHead>Duration</TableHead>
            <TableHead>Time</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {calls.map((call) => (
            <TableRow key={call.id}>
              <TableCell>
                <button
                  onClick={() => setSelectedContactId(call.contact_id)}
                  className="flex items-center gap-2 hover:underline text-left"
                >
                  <User className="h-4 w-4 text-muted-foreground" />
                  <span>
                    {call.contacts?.first_name || "Unknown"} {call.contacts?.last_name || ""}
                  </span>
                </button>
              </TableCell>
              <TableCell className="font-mono text-sm">
                {call.contacts?.phone || "--"}
              </TableCell>
              <TableCell>{getOutcomeBadge(call)}</TableCell>
              <TableCell>{formatDuration(call.duration_seconds)}</TableCell>
              <TableCell>{formatTime(call.created_at)}</TableCell>
              <TableCell className="text-right">
                <div className="flex items-center justify-end gap-2">
                  {call.voice_call_id && (
                    <Button variant="ghost" size="sm" asChild>
                      <Link href={`/dashboard/voice/review/${call.voice_call_id}`}>
                        <ExternalLink className="h-4 w-4" />
                      </Link>
                    </Button>
                  )}
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <ContactHistorySheet
        contactId={selectedContactId}
        open={!!selectedContactId}
        onOpenChange={(open) => !open && setSelectedContactId(null)}
      />
    </>
  )
}
