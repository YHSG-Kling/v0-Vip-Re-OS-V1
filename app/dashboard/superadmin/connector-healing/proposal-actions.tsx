"use client"

// Client island for the approve / reject buttons on a single proposal row. Kept tiny — all
// authorization + DB writes live in the server action, this only collects the optional note +
// dispatches and refreshes.
import { useState, useTransition } from "react"
import { Button } from "@/components/ui/button"
import { approveProposalAction, rejectProposalAction, revertProposalAction, applyConfigAlternateAction } from "@/app/actions/superadmin/connector-healing"
import { useRouter } from "next/navigation"

/** C25 (wave 148, lane 148I) — apply a DECLARED configuration alternate through the governed path (tested by the live probe;
 *  reverted at once if the probe fails). Reason required. */
export function ApplyConfigAlternate({ connector, alternateId }: { connector: string; alternateId: string }) {
  const [reason, setReason] = useState("")
  const [msg, setMsg] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const router = useRouter()
  return (
    <div className="flex flex-col gap-1">
      <input aria-label={`Why apply ${alternateId}`} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why (at least 10 characters)" className="text-xs rounded border px-2 py-1 bg-background" disabled={pending} />
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" className="text-xs" disabled={pending || reason.trim().length < 10}
          onClick={() => startTransition(async () => { const r = await applyConfigAlternateAction({ connector, alternateId, reason: reason.trim() }); setMsg(r.success ? r.outcome ?? "applied and verified" : r.error ?? "not applied"); router.refresh() })}>
          {pending ? "Applying + testing…" : "Apply (tested)"}
        </Button>
        {msg && <span className="text-xs text-muted-foreground">{msg}</span>}
      </div>
    </div>
  )
}

/** C25 (wave 148, lane 148I) — take an applied configuration version back (reason required; the server reverts and audits). */
export function RevertProposal({ proposalId }: { proposalId: string }) {
  const [reason, setReason] = useState("")
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const router = useRouter()
  if (!open) return <Button size="sm" variant="outline" className="ml-2 text-xs" onClick={() => setOpen(true)}>Revert</Button>
  return (
    <div className="mt-2 flex flex-col gap-1">
      <input aria-label="Why revert" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why (at least 10 characters)" className="text-xs rounded border px-2 py-1 bg-background" disabled={pending} />
      <div className="flex items-center gap-2">
        <Button size="sm" variant="destructive" className="text-xs" disabled={pending || reason.trim().length < 10}
          onClick={() => startTransition(async () => { const r = await revertProposalAction({ proposalId, reason: reason.trim() }); if (!r.success) setError(r.error ?? "Revert failed"); else router.refresh() })}>
          {pending ? "Reverting…" : "Confirm revert"}
        </Button>
        <Button size="sm" variant="ghost" className="text-xs" onClick={() => setOpen(false)} disabled={pending}>Cancel</Button>
        {error && <span className="text-xs text-red-700">{error}</span>}
      </div>
    </div>
  )
}

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
