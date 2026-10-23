"use client"

import { useState, useTransition } from "react"
import { toggleContentSource, deleteContentSource } from "@/app/actions/content-intel/sources"

export function ToggleButton({ id, isActive }: { id: string; isActive: boolean }) {
  const [pending, startTransition] = useTransition()
  return (
    <button
      onClick={() => startTransition(async () => { await toggleContentSource(id, !isActive) })}
      disabled={pending}
      className="text-xs px-2 py-1 border rounded hover:bg-gray-100 disabled:opacity-50"
    >
      {isActive ? "Pause" : "Resume"}
    </button>
  )
}

/**
 * Remove a BROKERAGE-PRIVATE source for good.
 *
 * Only rendered for rows the brokerage owns — platform-wide rows (brokerage_id
 * IS NULL) are read-only from this UI, and deleteContentSource enforces that
 * server-side with its own `.eq("brokerage_id", ctx.brokerageId)` predicate, so
 * hiding the button is a courtesy and not the boundary.
 *
 * Two-step: the first click arms, the second deletes. A one-click destructive
 * control next to Pause is how a source gets removed by accident.
 *
 * The action's error is SHOWN. A delete that Postgres refused must not look
 * identical to one that worked — the row simply staying put is exactly what a
 * successful delete plus a stale render also looks like.
 */
export function DeleteSourceButton({ id, label }: { id: string; label: string | null }) {
  const [pending, startTransition] = useTransition()
  const [armed, setArmed] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (error) {
    return (
      <span className="text-xs text-red-600" title={error}>
        Delete failed
      </span>
    )
  }

  if (!armed) {
    return (
      <button
        onClick={() => setArmed(true)}
        disabled={pending}
        className="text-xs px-2 py-1 border rounded text-red-600 hover:bg-red-50 disabled:opacity-50 ml-2"
        aria-label={`Delete ${label ?? "source"}`}
      >
        Delete
      </button>
    )
  }

  return (
    <span className="inline-flex items-center gap-1 ml-2">
      <button
        onClick={() =>
          startTransition(async () => {
            const r = await deleteContentSource(id)
            if (!r.ok) {
              setError(r.error ?? "Delete refused")
              return
            }
            setArmed(false)
          })
        }
        disabled={pending}
        className="text-xs px-2 py-1 border border-red-300 rounded bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
      >
        {pending ? "Deleting…" : "Confirm"}
      </button>
      <button
        onClick={() => setArmed(false)}
        disabled={pending}
        className="text-xs px-2 py-1 border rounded hover:bg-gray-100 disabled:opacity-50"
      >
        Cancel
      </button>
    </span>
  )
}
