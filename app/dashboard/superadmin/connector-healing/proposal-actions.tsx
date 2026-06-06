"use client"

// Client island for the approve / reject buttons on a single proposal row. Kept tiny — all
// authorization + DB writes live in the server action, this only collects the optional note +
// dispatches and refreshes.
import { useState, useTransition } from "react"
import { Button } from "@/components/ui/button"
import { approveProposalAction, rejectProposalAction } from "@/app/actions/superadmin/connector-healing"
import { useRouter } from "next/navigation"

export function ProposalActions({ proposalId }: { proposalId: string }) {
  const [notes, setNotes] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const router = useRouter()

  const onAct = (kind: "approve" | "reject") => {
    setError(null)
    startTransition(async () => {
      const fn = kind === "approve" ? approveProposalAction : rejectProposalAction
      const res = await fn({ proposalId, notes: notes.trim() || undefined })
      if (!res.success) setError(res.error ?? "Action failed")
      else router.refresh()
    })
  }

  return (
    <div className="flex flex-col gap-2 pt-2 border-t">
      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Notes (optional) — e.g. 'verified against docs, applied in commit abc123'"
        className="text-xs w-full rounded border px-2 py-1 min-h-[40px] bg-background"
        disabled={pending}
      />
      <div className="flex items-center gap-2">
        <Button size="sm"  variant="default" disabled={pending} onClick={() => onAct("approve")}>
          {pending ? "Working…" : "Approve"}
        </Button>
        <Button size="sm"  variant="outline" disabled={pending} onClick={() => onAct("reject")}>
          Reject
        </Button>
        {error && <span className="text-xs text-red-600">{error}</span>}
      </div>
    </div>
  )
}
