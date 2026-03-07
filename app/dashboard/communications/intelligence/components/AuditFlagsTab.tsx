"use client"

import { useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { reviewAuditFlag } from "@/app/actions/conversation-analytics"

interface AuditFlag {
  id: string
  conversation_id: string            // → conversation_logs.id
  risk_type: string
  risk_score: number
  explanation: string
  flagged_text: string
  recommended_action: string
  review_status: string
  created_at: string
  conversation: {
    contact_id: string
    agent_id: string
    start_time: string
    topics_discussed: string[]
  } | null
}

interface AuditFlagsTabProps {
  flags: AuditFlag[]
  reviewerId: string
}

function riskBadge(type: string) {
  if (type === "fair_housing") return "bg-red-100 text-red-700"
  if (type === "data_leak")    return "bg-orange-100 text-orange-700"
  if (type === "hallucination") return "bg-yellow-100 text-yellow-700"
  return "bg-gray-100 text-gray-600"
}

function statusBadge(status: string) {
  if (status === "reviewed")  return "bg-green-100 text-green-700"
  if (status === "dismissed") return "bg-gray-100 text-gray-500"
  if (status === "escalated") return "bg-red-100 text-red-700"
  return "bg-yellow-100 text-yellow-700"  // pending
}

export default function AuditFlagsTab({ flags, reviewerId }: AuditFlagsTabProps) {
  const [localFlags, setLocalFlags] = useState<AuditFlag[]>(flags)
  const [loading, setLoading] = useState<string | null>(null)
  const [notes, setNotes] = useState<Record<string, string>>({})

  async function handleReview(flagId: string, status: "reviewed" | "dismissed" | "escalated") {
    setLoading(flagId)
    try {
      await reviewAuditFlag({ flagId, reviewerId, status, resolutionNotes: notes[flagId] })
      setLocalFlags(prev =>
        prev.map(f => f.id === flagId ? { ...f, review_status: status } : f)
      )
    } finally {
      setLoading(null)
    }
  }

  return (
    <div className="space-y-3">
      {localFlags.length === 0 && (
        <div className="rounded-lg border border-border bg-card p-8 text-center text-muted-foreground text-sm">
          No audit flags to review.
        </div>
      )}
      {localFlags.map(flag => (
        <div key={flag.id} className="rounded-lg border border-border bg-card p-4 space-y-3">
          <div className="flex flex-wrap items-start gap-2 justify-between">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-semibold uppercase ${riskBadge(flag.risk_type)}`}>
                {flag.risk_type.replace(/_/g, " ")}
              </span>
              <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium capitalize ${statusBadge(flag.review_status)}`}>
                {flag.review_status}
              </span>
              <span className="text-xs text-muted-foreground">
                Risk score: <strong>{flag.risk_score}</strong>/10
              </span>
            </div>
            <span className="text-xs text-muted-foreground">
              {new Date(flag.created_at).toLocaleDateString()}
            </span>
          </div>

          <div>
            <p className="text-sm font-medium text-foreground">{flag.explanation}</p>
            {flag.flagged_text && (
              <p className="text-xs text-muted-foreground mt-0.5">
                Flagged: <code className="bg-muted px-1 rounded">{flag.flagged_text}</code>
              </p>
            )}
            <p className="text-xs text-muted-foreground mt-1 italic">{flag.recommended_action}</p>
          </div>

          {flag.conversation && (
            <div className="text-xs text-muted-foreground flex flex-wrap gap-3">
              <span>Conv log: <code className="bg-muted px-1 rounded">{flag.conversation_id.slice(0, 8)}…</code></span>
              {flag.conversation.topics_discussed?.length > 0 && (
                <span>Topics: {flag.conversation.topics_discussed.join(", ")}</span>
              )}
            </div>
          )}

          {flag.review_status === "pending" && (
            <div className="pt-1 space-y-2">
              <textarea
                rows={2}
                placeholder="Resolution notes (optional)"
                value={notes[flag.id] ?? ""}
                onChange={e => setNotes(p => ({ ...p, [flag.id]: e.target.value }))}
                className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring resize-none"
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="text-xs"
                  disabled={loading === flag.id}
                  onClick={() => handleReview(flag.id, "reviewed")}
                >
                  Mark Reviewed
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="text-xs text-yellow-600 border-yellow-300 hover:bg-yellow-50"
                  disabled={loading === flag.id}
                  onClick={() => handleReview(flag.id, "escalated")}
                >
                  Escalate
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-xs text-muted-foreground"
                  disabled={loading === flag.id}
                  onClick={() => handleReview(flag.id, "dismissed")}
                >
                  Dismiss
                </Button>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
