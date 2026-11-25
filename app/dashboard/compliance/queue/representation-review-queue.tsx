"use client"

/**
 * EXECUTED PACKETS ON THE COMPLIANCE QUEUE (wave 156, lane 156B round 2). The listing agreements and executed offers waiting for a
 * reviewer or for a repair, read through listRepresentationReviewQueueAction (scoped server-side). Each opens the full review in
 * place (representation-review-panel.tsx). An empty queue and a failed load read differently — a failed load is never "nothing to do".
 */

import { useEffect, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { listRepresentationReviewQueueAction } from "@/app/actions/compliance/representation-review"
import { RepresentationReviewPanel } from "./representation-review-panel"

type Q = Awaited<ReturnType<typeof listRepresentationReviewQueueAction>>
const STATE_LABEL: Record<string, string> = { awaiting_review: "waiting for a reviewer", blocked: "on hold — repair needed", revoked: "approval revoked — repair needed" }

export function RepresentationReviewQueue() {
  const [q, setQ] = useState<Q | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  useEffect(() => { listRepresentationReviewQueueAction().then(setQ).catch(() => setQ({ success: false, error: "The review queue could not be loaded, so this is not an empty queue.", items: [] })) }, [])
  if (!q) return <p className="text-sm text-muted-foreground">Loading executed packets…</p>
  if (!q.success) return <p className="text-sm text-red-700">{q.error}</p>
  if (q.items.length === 0) return <p className="text-sm text-muted-foreground py-4 text-center">No executed listing agreements or offers are waiting for review or repair.</p>
  return (
    <ul className="divide-y">
      {q.items.map((it) => {
        const key = `${it.record}:${it.subjectId}`
        return (
          <li key={key} className="py-3">
            <div className="flex items-start gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-sm font-medium truncate">{it.record === "listing_agreement" ? "Listing agreement" : "Executed offer"} — {it.title}</p>
                  <Badge variant="outline">{STATE_LABEL[it.state] ?? it.state}</Badge>
                </div>
                {it.blockers.slice(0, 3).map((b, i) => <p key={i} className="text-xs text-muted-foreground mt-1">{b}</p>)}
              </div>
              <Button size="sm" variant="outline" onClick={() => setOpen(open === key ? null : key)}>{open === key ? "Close" : "Open review"}</Button>
            </div>
            {open === key && <div className="mt-3"><RepresentationReviewPanel record={it.record} subjectId={it.subjectId} /></div>}
          </li>
        )
      })}
    </ul>
  )
}
