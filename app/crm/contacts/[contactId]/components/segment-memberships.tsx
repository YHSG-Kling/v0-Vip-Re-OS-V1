"use client"

/**
 * app/crm/contacts/[contactId]/components/segment-memberships.tsx
 *
 * "Take me off that list."
 *
 * The segment badges on the contact page used to be read-only, and that was the
 * visible face of a real defect: `contact_segments.removed_at` was read by the
 * campaign sender (lib/marketing/email-campaign-sender.ts:148, `removed_at IS
 * NULL`) and written by NOTHING. A contact added to a marketing segment by a
 * workflow step received that segment's campaigns forever, and no agent could
 * stop it.
 *
 * This is the manual door. The write goes through
 * app/actions/contacts/segment-membership.ts, which proves the caller may act
 * on this contact and takes the brokerage off the gated contact row — never off
 * anything this component sends.
 *
 * Segments are shown by id prefix because `contact_segments.segment_id` carries
 * no FK and the tree has no segment catalog to name them from. Displaying a
 * fake name would be worse than an honest id.
 */

import { useState, useTransition } from "react"
import { Loader2, X } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { removeContactFromSegmentAction } from "@/app/actions/contacts/segment-membership"

export interface ContactSegmentRow {
  id: string
  segment_id: string
  added_at: string
}

export function SegmentMemberships({
  contactId,
  segments,
}: {
  contactId: string
  segments: ContactSegmentRow[]
}) {
  // Rows the server has confirmed closed. The server action revalidates the
  // page, but the optimistic set keeps the badge from flashing back in first.
  const [removed, setRemoved] = useState<Set<string>>(new Set())
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  const visible = segments.filter((s) => !removed.has(s.id))
  if (visible.length === 0 && !error) return null

  function remove(row: ContactSegmentRow) {
    setPendingId(row.id)
    setError(null)
    startTransition(async () => {
      const res = await removeContactFromSegmentAction({
        contactId,
        segmentId: row.segment_id,
      })
      setPendingId(null)
      if (!res.ok) {
        // The action distinguishes "nothing matched" from "it worked", so a
        // refusal is shown rather than swallowed into a disappearing badge.
        setError(res.error)
        return
      }
      setRemoved((prev) => new Set(prev).add(row.id))
    })
  }

  return (
    <div className="px-4 pt-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-muted-foreground">Segments</span>
        {visible.map((s) => (
          <Badge key={s.id} variant="secondary" className="gap-1 pr-1 text-xs font-mono">
            {s.segment_id.slice(0, 8)}
            <button
              type="button"
              aria-label={`Remove this contact from segment ${s.segment_id}`}
              title="Remove from this segment — segment campaigns stop reaching them"
              className="rounded-sm p-0.5 opacity-60 transition-opacity hover:opacity-100 disabled:opacity-40"
              disabled={isPending}
              onClick={() => remove(s)}
            >
              {pendingId === s.id && isPending
                ? <Loader2 className="h-3 w-3 animate-spin" />
                : <X className="h-3 w-3" />}
            </button>
          </Badge>
        ))}
      </div>
      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
    </div>
  )
}
