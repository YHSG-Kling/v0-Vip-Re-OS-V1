"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { formatDistanceToNow } from "date-fns"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Mic } from "lucide-react"
import {
  listResumableIntakeSessions,
  type ResumableIntakeSession,
} from "@/app/actions/voice-assistant/list-resumable-intake-sessions"

/**
 * <ResumeIntakeCard> — the "pick up where you left off" widget for voice
 * intakes. Mirrors open-actions-card.tsx: client component, useEffect → server
 * action, null while loading (no flash), null on empty (the card earns its
 * space only when there is something to resume).
 *
 * Each row deep-links into /mobile/voice with ?resume=<id>&mode=<intake_type>;
 * the page re-verifies ownership server-side before threading the session.
 */
export function ResumeIntakeCard() {
  const [sessions, setSessions] = useState<ResumableIntakeSession[] | null>(null)

  useEffect(() => {
    let cancelled = false
    listResumableIntakeSessions()
      .then((r) => {
        if (!cancelled && r.ok) setSessions(r.sessions ?? [])
      })
      .catch(() => {
        if (!cancelled) setSessions([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (sessions == null) return null      // initial load — no flash
  if (sessions.length === 0) return null // nothing unfinished — hide

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Mic className="h-4 w-4" /> Unfinished voice intakes
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {sessions.map((s) => (
          <Link
            key={s.id}
            href={`/mobile/voice?resume=${s.id}&mode=${s.intakeType}`}
            className="flex items-center justify-between gap-3 rounded-lg border p-3 hover:bg-muted/40 transition-colors"
          >
            <div className="min-w-0">
              <p className="text-sm font-medium">
                Unfinished {s.intakeType} intake
              </p>
              <p className="text-xs text-muted-foreground truncate">
                {s.contactName ?? s.propertyAddress ?? "No contact yet"}
                {" · "}
                {formatDistanceToNow(new Date(s.updatedAt), { addSuffix: true })}
              </p>
            </div>
            {s.status === "ready_to_draft" ? (
              <Badge className="shrink-0 bg-emerald-100 text-emerald-800">Ready to finalize</Badge>
            ) : (
              <Badge className="shrink-0 bg-amber-100 text-amber-800">Needs more info</Badge>
            )}
          </Link>
        ))}
      </CardContent>
    </Card>
  )
}
